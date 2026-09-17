"""
AYUSH-IPR GUARDIAN — Kaggle RAG Server
=======================================
Run on Kaggle with T4 x2 GPU (2 × 16GB VRAM).

Models:
  - LLM: Gemma-2-2B-IT (float16, ~5GB VRAM) — chat & legal reasoning
  - TTS: OmniVoice (~2.5GB VRAM) — cross-lingual speech synthesis (Hindi+English)
  - ASR: faster-whisper-small (~0.5GB) — speech-to-text
  - Embeddings: BGE-M3 (568M, dense+sparse) — retrieval
  - Reranker: bge-reranker-v2-m3 — cross-encoder scoring

GPU Layout:
  GPU 0: Gemma-2-2B-IT (5GB) — dedicated LLM, no contention
  GPU 1: BGE-M3 (1.2GB) + Reranker (1.2GB) + Whisper (0.5GB) + OmniVoice (2.5GB)

RAG Pipeline: Query → Dense(FAISS)+Sparse(BM25) → RRF → CrossEncoder → Gemma 2B → Cite
Voice Pipeline: Mic → Whisper ASR → RAG Chat → OmniVoice TTS → Speaker
"""

# ============================================================
# CELL 1: INSTALL DEPENDENCIES & FAST STARTUP OPTIMIZATION
# ============================================================
import subprocess, sys, os, time, shutil

print("=" * 60)
print("  AYUSH-IPR GUARDIAN — Fast Startup Initialization")
print("=" * 60, flush=True)

# 1. Download Cloudflare Tunnel binary directly (takes ~1-2 seconds)
if not os.path.exists("/usr/local/bin/cloudflared"):
    print("  Downloading Cloudflare Tunnel (cloudflared)...", flush=True)
    os.system("curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared")

# 2. Check ffmpeg (Kaggle has ffmpeg pre-installed; avoid running slow apt-get if present)
if shutil.which("ffmpeg") is None:
    print("  Installing ffmpeg...", flush=True)
    os.system("apt-get update -qq && apt-get install -y ffmpeg >/dev/null 2>&1 || true")

# 3. Batch pip install only missing packages in a single command
required_packages = [
    "transformers>=4.51.0",
    "accelerate",
    "sentence-transformers",
    "faiss-cpu",
    "rank-bm25",
    "faster-whisper",
    "omnivoice",
    "soundfile",
    "fastapi",
    "uvicorn",
    "nest-asyncio",
    "python-multipart",
    "pydantic",
    "hf_transfer",
]
print("  Installing dependencies in batch...", flush=True)
subprocess.check_call(
    [sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check", "--no-warn-script-location"] + required_packages,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
)

# Enable fast HF downloads
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
os.environ["HF_HUB_DOWNLOAD_TIMEOUT"] = "120"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# HuggingFace authentication (Gemma is a gated model)
HF_TOKEN = os.environ.get("HF_TOKEN", os.environ.get("HUGGING_FACE_HUB_TOKEN", ""))
if not HF_TOKEN:
    try:
        from kaggle_secrets import UserSecretsClient
        user_secrets = UserSecretsClient()
        HF_TOKEN = user_secrets.get_secret("HF_TOKEN")
    except Exception:
        pass

if HF_TOKEN:
    try:
        from huggingface_hub import login
        login(token=HF_TOKEN, add_to_git_credential=False)
        print("✓ Logged into HuggingFace Hub with HF_TOKEN", flush=True)
    except Exception as e:
        print(f"HF login warning: {e}", flush=True)
else:
    print("ℹ No HF_TOKEN detected — ungated model fallbacks will be used if needed", flush=True)

print("✓ Fast startup dependencies ready", flush=True)

# ============================================================
# CELL 2: IMPORTS
# ============================================================
import torch
import numpy as np
import json
import re
import threading
import tempfile
import hashlib
import io
import queue
import urllib.request
from datetime import datetime
from typing import Optional, List, Dict
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import nest_asyncio

print("✓ All imports successful", flush=True)

# ============================================================
# CELL 3: VRAM MONITOR
# ============================================================

def vram_report(label=""):
    """Print detailed VRAM usage for all GPUs."""
    if not torch.cuda.is_available():
        print(f"  [{label}] No CUDA available — running on CPU", flush=True)
        return {}
    report = {}
    for i in range(torch.cuda.device_count()):
        alloc = torch.cuda.memory_allocated(i) / 1e9
        reserved = torch.cuda.memory_reserved(i) / 1e9
        total = torch.cuda.get_device_properties(i).total_memory / 1e9
        free = total - alloc
        report[i] = {"allocated": alloc, "reserved": reserved, "total": total, "free": free}
        print(f"  [{label}] GPU {i} ({torch.cuda.get_device_name(i)}): "
              f"{alloc:.2f}GB alloc / {free:.2f}GB free / {total:.1f}GB total", flush=True)
    return report


def vram_free(gpu_id=0):
    """Return free VRAM in GB for a given GPU."""
    if not torch.cuda.is_available():
        return 0
    total = torch.cuda.get_device_properties(gpu_id).total_memory / 1e9
    alloc = torch.cuda.memory_allocated(gpu_id) / 1e9
    return total - alloc


# Enable PyTorch expandable segments to avoid memory fragmentation
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"


def cleanup_gpu(gpu_id=None):
    """Force cleanup GPU memory thoroughly."""
    import gc
    gc.collect()
    if torch.cuda.is_available():
        if gpu_id is not None:
            with torch.cuda.device(gpu_id):
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        else:
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()


# ============================================================
# CELL 4: RAG DATABASE LOADER
# ============================================================

class RAGDatabase:
    """Loads UDO JSON records and builds a FAISS vector index + BM25 sparse index."""

    def __init__(self):
        self.records = []
        self.embeddings = None
        self.index = None
        self.embed_model = None
        self.reranker = None
        self.bm25 = None            # BM25 sparse retriever
        self.bm25_corpus = None     # Tokenized corpus for BM25
        self.loaded = False

    def load_database(self, json_path: str):
        """Load UDO records from JSON file."""
        print(f"  Loading RAG database from: {json_path}", flush=True)
        with open(json_path, 'r', encoding='utf-8') as f:
            self.records = json.load(f)
        print(f"  ✓ Loaded {len(self.records)} UDO records", flush=True)

    def load_embeddings_model(self, device="cuda:1"):
        """Load BGE-M3 embedding model."""
        print(f"  Loading BGE-M3 embeddings on {device}...", flush=True)
        vram_report("pre-BGE-M3")

        from sentence_transformers import SentenceTransformer
        self.embed_model = SentenceTransformer(
            "BAAI/bge-m3",
            device=device,
            model_kwargs={"torch_dtype": torch.float16}
        )
        print(f"  ✓ BGE-M3 loaded", flush=True)
        vram_report("post-BGE-M3")

    def load_reranker(self, device="cuda:1"):
        """Load bge-reranker-v2-m3 cross-encoder."""
        print(f"  Loading bge-reranker-v2-m3 on {device}...", flush=True)
        vram_report("pre-reranker")

        from sentence_transformers import CrossEncoder
        self.reranker = CrossEncoder(
            "BAAI/bge-reranker-v2-m3",
            device=device,
            max_length=512,
        )
        print(f"  ✓ Reranker loaded", flush=True)
        vram_report("post-reranker")

    def build_index(self):
        """Embed all records and build FAISS vector index + BM25 sparse index with fast-path caching."""
        import faiss
        import pickle
        from rank_bm25 import BM25Okapi

        print(f"  Initializing FAISS + BM25 hybrid index for {len(self.records)} records...", flush=True)

        # ⚡ Fast-path: Check for pre-computed FAISS index & BM25 corpus on disk
        faiss_candidates = [
            "/kaggle/working/faiss_bge_m3.index",
            "/kaggle/input/ayush-ipr-rag-database/faiss_bge_m3.index",
            "/kaggle/input/ayush-ipr-rag-database/ayush-ipr-rag-database/faiss_bge_m3.index",
        ]
        bm25_candidates = [
            "/kaggle/working/bm25_corpus.pkl",
            "/kaggle/input/ayush-ipr-rag-database/bm25_corpus.pkl",
            "/kaggle/input/ayush-ipr-rag-database/ayush-ipr-rag-database/bm25_corpus.pkl",
        ]
        if os.path.exists("/kaggle/input"):
            for root, dirs, files in os.walk("/kaggle/input"):
                for fname in files:
                    if fname == "faiss_bge_m3.index":
                        faiss_candidates.append(os.path.join(root, fname))
                    elif fname == "bm25_corpus.pkl":
                        bm25_candidates.append(os.path.join(root, fname))

        found_faiss = next((p for p in faiss_candidates if os.path.exists(p) and os.path.getsize(p) > 500000), None)
        found_bm25 = next((p for p in bm25_candidates if os.path.exists(p) and os.path.getsize(p) > 50000), None)

        if found_faiss and found_bm25:
            try:
                t0 = time.time()
                print(f"  ⚡ Fast Load: Pre-computed FAISS index found at {found_faiss}", flush=True)
                self.index = faiss.read_index(found_faiss)
                with open(found_bm25, "rb") as f:
                    self.bm25_corpus = pickle.load(f)
                self.bm25 = BM25Okapi(self.bm25_corpus)
                self.loaded = True
                print(f"  ✓ Pre-computed Hybrid index loaded in {time.time() - t0:.2f}s! {self.index.ntotal} vectors + BM25 ({len(self.bm25_corpus)} docs)", flush=True)
                return
            except Exception as e:
                print(f"  Warning loading pre-computed index: {e}. Falling back to dynamic build.", flush=True)

        # Fallback: Dynamic build with optimized batch size and inference mode
        texts = []
        tokenized_corpus = []
        for r in self.records:
            # Combine title + content for richer embedding
            text = f"{r['title']}\n{r.get('content_plain', r.get('content', ''))}"
            # Truncate to ~750 tokens worth (~3000 chars) — BGE-M3 supports 8192 tokens
            texts.append(text[:3000])
            # Tokenize for BM25 (lowercase, split on whitespace + punctuation)
            tokens = re.findall(r'\w+', text[:3000].lower())
            tokenized_corpus.append(tokens)

        # --- Dense: FAISS with high-throughput batching ---
        with torch.inference_mode():
            self.embeddings = self.embed_model.encode(
                texts,
                batch_size=64,
                show_progress_bar=True,
                normalize_embeddings=True,
            )

        # Build FAISS index (inner product for normalized vectors = cosine)
        dim = self.embeddings.shape[1]
        self.index = faiss.IndexFlatIP(dim)
        self.index.add(self.embeddings.astype(np.float32))

        # --- Sparse: BM25 ---
        self.bm25 = BM25Okapi(tokenized_corpus)
        self.bm25_corpus = tokenized_corpus

        # Save to /kaggle/working/ for instant recovery on restart
        try:
            faiss.write_index(self.index, "/kaggle/working/faiss_bge_m3.index")
            with open("/kaggle/working/bm25_corpus.pkl", "wb") as f:
                pickle.dump(self.bm25_corpus, f, protocol=pickle.HIGHEST_PROTOCOL)
            print("  ✓ Cached pre-computed index & BM25 corpus to /kaggle/working/ for subsequent instant boots", flush=True)
        except Exception as e:
            print(f"  Note: Cache save note: {e}", flush=True)

        self.loaded = True
        print(f"  ✓ Hybrid index built: {self.index.ntotal} vectors (dim={dim}) + BM25 ({len(tokenized_corpus)} docs)", flush=True)

    def search_dense(self, query: str, top_k: int = 20) -> List[Dict]:
        """Search for relevant records using dense vector similarity."""
        if not self.loaded or self.index is None:
            return []

        # Encode query
        q_emb = self.embed_model.encode(
            [query],
            normalize_embeddings=True,
        ).astype(np.float32)

        # FAISS search
        scores, indices = self.index.search(q_emb, top_k)

        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx < len(self.records):
                record = self.records[idx].copy()
                record["similarity_score"] = float(score)
                record["_idx"] = int(idx)  # Track original index for RRF
                results.append(record)

        return results

    def search_sparse(self, query: str, top_k: int = 20) -> List[Dict]:
        """Search for relevant records using BM25 keyword matching."""
        if not self.loaded or self.bm25 is None:
            return []

        query_tokens = re.findall(r'\w+', query.lower())
        bm25_scores = self.bm25.get_scores(query_tokens)

        # Get top-k indices by BM25 score
        top_indices = np.argsort(bm25_scores)[::-1][:top_k]

        results = []
        for idx in top_indices:
            if bm25_scores[idx] > 0 and idx < len(self.records):
                record = self.records[idx].copy()
                record["bm25_score"] = float(bm25_scores[idx])
                record["_idx"] = int(idx)
                results.append(record)

        return results

    def search(self, query: str, top_k: int = 25) -> List[Dict]:
        """Hybrid search: Dense (FAISS) + Sparse (BM25) with Reciprocal Rank Fusion."""
        if not self.loaded:
            return []

        # Get results from both retrievers
        dense_results = self.search_dense(query, top_k=top_k)
        sparse_results = self.search_sparse(query, top_k=top_k)

        # --- Reciprocal Rank Fusion (RRF) ---
        k = 60  # RRF constant
        rrf_scores = {}  # idx -> cumulative RRF score
        idx_to_record = {}  # idx -> record dict

        for rank, r in enumerate(dense_results):
            idx = r["_idx"]
            rrf_scores[idx] = rrf_scores.get(idx, 0) + 1.0 / (k + rank + 1)
            idx_to_record[idx] = r

        for rank, r in enumerate(sparse_results):
            idx = r["_idx"]
            rrf_scores[idx] = rrf_scores.get(idx, 0) + 1.0 / (k + rank + 1)
            if idx not in idx_to_record:
                idx_to_record[idx] = r

        # Sort by RRF score (descending) and return top results
        sorted_indices = sorted(rrf_scores.keys(), key=lambda i: rrf_scores[i], reverse=True)

        results = []
        for idx in sorted_indices[:top_k]:
            record = idx_to_record[idx]
            record["rrf_score"] = rrf_scores[idx]
            record["similarity_score"] = record.get("similarity_score", 0)
            results.append(record)

        return results

    def rerank(self, query: str, results: List[Dict], top_k: int = 7) -> List[Dict]:
        """Rerank results using cross-encoder. Expanded from top-5 to top-7 for better coverage."""
        if not self.reranker or not results:
            return results[:top_k]

        # Prepare pairs for cross-encoder
        pairs = []
        for r in results:
            text = f"{r['title']}\n{r.get('content_plain', r.get('content', ''))}"
            pairs.append([query, text[:3000]])

        # Score
        scores = self.reranker.predict(pairs)

        # Attach scores and sort
        for i, r in enumerate(results):
            r["rerank_score"] = float(scores[i])
        results.sort(key=lambda x: x["rerank_score"], reverse=True)

        return results[:top_k]

    def hybrid_search(self, query: str, top_k: int = 5) -> List[Dict]:
        """Full hybrid search: Dense+Sparse(RRF) retrieval → cross-encoder reranking → top-k.
        Optimized: 20 candidates instead of 40 (cross-encoder is the main bottleneck)."""
        # Step 1: Hybrid search with RRF (top-20 candidates — 40 was overkill, reranker is O(n))
        candidates = self.search(query, top_k=20)

        # Step 2: Rerank with cross-encoder → top-5 (sufficient for legal context)
        reranked = self.rerank(query, candidates, top_k=top_k)

        return reranked

    def cleanup(self):
        """Release all GPU memory."""
        print("  Cleaning up RAG models...", flush=True)
        if self.embed_model is not None:
            del self.embed_model
            self.embed_model = None
        if self.reranker is not None:
            del self.reranker
            self.reranker = None
        cleanup_gpu()
        print("  ✓ RAG models cleaned up", flush=True)


# ============================================================
# CELL 5: LLM MANAGER — GEMMA 2 2B-IT (FLOAT16, FAST)
# ============================================================

class LLMManager:
    """Manages Gemma-2-2B-IT in float16 on GPU 0.
    Priority: Kaggle pre-cached → HF Hub download.
    No fallbacks — Gemma 2B is the target model.
    """

    KAGGLE_MODEL_PATH = "/kaggle/input/gemma-2/transformers/gemma-2-2b-it/1"
    HF_MODEL_ID = "google/gemma-2-2b-it"

    def __init__(self):
        self.model = None
        self.tokenizer = None
        self.model_name = None
        self.model_id = None
        self.engine_type = "fp16"
        self.device = "cuda:0"
        self.loaded = False

    def load(self, device="cuda:0"):
        """Load Gemma-2-2B-IT in float16."""
        from transformers import AutoTokenizer, AutoModelForCausalLM

        self.device = device
        gpu_idx = int(device.split(":")[-1]) if ":" in device else 0
        free = vram_free(gpu_idx)
        print(f"\n  LLM Loading — Available VRAM on {device}: {free:.1f}GB", flush=True)

        # Build candidate list: local cache first, then HF Hub
        candidates = []

        # 1. Kaggle pre-cached path (fastest — no download)
        if os.path.isdir(self.KAGGLE_MODEL_PATH):
            candidates.append(("Gemma-2-2B-IT (Kaggle)", self.KAGGLE_MODEL_PATH))

        # 2. Auto-discover any Gemma model in /kaggle/input
        if os.path.exists("/kaggle/input"):
            for root, dirs, files in os.walk("/kaggle/input"):
                if "config.json" in files and "gemma" in root.lower():
                    candidates.append(("Gemma (Auto-discovered)", root))
                    break

        # 3. Unsloth ungated mirror (Exact Gemma-2-2B-IT weights, zero auth required)
        candidates.append(("Gemma-2-2B-IT (Ungated Mirror)", "unsloth/gemma-2-2b-it"))

        # 4. Download from official HF Hub (gated, requires token)
        candidates.append(("Gemma-2-2B-IT (Official HF)", self.HF_MODEL_ID))

        for display_name, model_path in candidates:
            print(f"\n  → Loading: {display_name} [{model_path}]...", flush=True)
            load_kwargs = {"trust_remote_code": True}
            if HF_TOKEN:
                load_kwargs["token"] = HF_TOKEN

            try:
                vram_report(f"pre-{display_name[:10]}")
                self.tokenizer = AutoTokenizer.from_pretrained(model_path, **load_kwargs)

                if self.tokenizer.pad_token is None:
                    self.tokenizer.pad_token = self.tokenizer.eos_token

                self.model = AutoModelForCausalLM.from_pretrained(
                    model_path,
                    device_map={"": device},
                    torch_dtype=torch.float16,
                    attn_implementation="sdpa",
                    **load_kwargs,
                )
                self.model.eval()

                self.model_name = display_name
                self.model_id = model_path
                self.engine_type = "fp16-sdpa"
                self.loaded = True
                print(f"  ✓ {display_name} loaded on {device}!", flush=True)
                vram_report("post-llm")
                return True

            except Exception as e:
                print(f"  ✗ Failed to load {display_name}: {e}", flush=True)
                if self.model is not None:
                    del self.model
                    self.model = None
                if self.tokenizer is not None:
                    del self.tokenizer
                    self.tokenizer = None
                cleanup_gpu(gpu_idx)
                continue

        print("  ✗ FATAL: Could not load Gemma-2-2B-IT.", flush=True)
        return False

    def prepare_inputs(self, system_prompt: str, user_message: str, is_hindi: bool = False, is_out_of_domain: bool = False, history: Optional[List[Dict]] = None, is_translation: bool = False, target_lang: str = "hi"):
        """Prepare chat template token inputs according to model family with multi-turn history support."""
        if not self.loaded or self.tokenizer is None:
            return None

        # Build multi-turn messages array with strict role alternation
        messages = []
        if history and len(history) > 0:
            last_role = None
            for turn in history[-6:]:
                content = str(turn.get("content", "")).strip()
                if not content:
                    continue
                role = turn.get("role", "user")
                r = "model" if role in ("assistant", "model") else "user"
                # First message in history must strictly be from user
                if not messages and r != "user":
                    continue
                if r == last_role:
                    messages[-1]["content"] += f"\n\n{content}"
                else:
                    messages.append({"role": r, "content": content})
                    last_role = r

            # Ensure multi-turn history ends on model turn so new query is user turn
            while messages and messages[-1]["role"] == "user":
                messages.pop()

        # Ensure the first turn in conversation has the system persona prepended
        if messages and messages[0]["role"] == "user":
            base_persona = "You are AYUSH-IPR GUARDIAN, an expert AI legal advisory assistant for Indian Traditional Medicine (AYUSH) and Intellectual Property Law."
            if not messages[0]["content"].startswith("You are AYUSH-IPR"):
                messages[0]["content"] = f"{base_persona}\n\n" + messages[0]["content"]

        # Gemma format (merged context in user message) vs standard system/user format (Qwen/Llama)
        if "gemma" in str(self.model_name).lower() or "gemma" in str(self.model_id).lower():
            if is_translation:
                if target_lang == "hi" or "hindi" in target_lang.lower() or "हिंदी" in target_lang:
                    latest_turn_content = (
                        f"उपयोगकर्ता का अनुरोध: {user_message}\n\n"
                        f"अति आवश्यक निर्देश:\n"
                        f"1. ऊपर दिए गए सहायक (Assistant) के पिछले उत्तर का पूर्ण, सटीक और विस्तृत अनुवाद हिंदी (देवनागरी लिपि) में प्रस्तुत करें।\n"
                        f"2. पिछले उत्तर के सभी मुख्य बिंदुओं (जैसे नियम, मानक, प्रक्रियाएं) का क्रमबद्ध और स्पष्ट अनुवाद दें।\n"
                        f"3. कोई नया असंबद्ध विषय न जोड़ें और कोई काल्पनिक नया प्रश्न न बनाएं। सीधे अनुवाद से उत्तर प्रारंभ करें।"
                    )
                else:
                    latest_turn_content = (
                        f"User Request: {user_message}\n\n"
                        f"CRITICAL INSTRUCTION:\n"
                        f"1. Provide a complete, faithful, and detailed English translation of the previous Assistant response above.\n"
                        f"2. Retain all regulatory points, statutory provisions, and step-by-step guidance.\n"
                        f"3. Do NOT introduce new unrelated topics or ask new questions. Begin directly with the translated response."
                    )
                messages.append({"role": "user", "content": latest_turn_content})
            elif is_out_of_domain:
                if is_hindi:
                    combined = (
                        f"{system_prompt}\n\n"
                        f"उपयोगकर्ता का प्रश्न: {user_message}\n\n"
                        f"निर्देश: यह प्रश्न पारंपरिक चिकित्सा या कानून से असंबंधित है। 1-2 विनम्र वाक्यों में बताएं कि आप केवल आयुष और पेटेंट कानून के सलाहकार हैं, और उन्हें आयुष संबंधित प्रश्न पूछने को कहें।"
                    )
                else:
                    combined = (
                        f"{system_prompt}\n\n"
                        f"User Query: {user_message}\n\n"
                        f"Instruction: This inquiry appears completely off-topic. In 1-2 polite sentences, state that you specialize in AYUSH traditional medicine and patent law, and invite them to ask an AYUSH/IPR question."
                    )
                messages.append({"role": "user", "content": combined})
            elif len(messages) > 0:
                # Follow-up query in existing conversation
                if is_hindi:
                    combined = (
                        f"{system_prompt}\n\n"
                        f"उपयोगकर्ता का अनुवर्ती प्रश्न: {user_message}\n\n"
                        f"निर्देश: यह पूर्व बातचीत का अनुवर्ती प्रश्न है। ऊपर दी गई बातचीत और वैधानिक संदर्भ के आधार पर उपयोगकर्ता के प्रश्न का सीधा, केंद्रित और कानूनी रूप से सही उत्तर हिंदी (देवनागरी) में प्रदान करें।"
                    )
                else:
                    combined = (
                        f"{system_prompt}\n\n"
                        f"User Follow-up Query: {user_message}\n\n"
                        f"Instruction: This is a follow-up inquiry continuing the previous dialogue. Using the conversation history and statutory context above, provide a direct, focused, and legally grounded advisory."
                    )
                messages.append({"role": "user", "content": combined})
            elif is_hindi:
                combined = (
                    f"{system_prompt}\n\n"
                    f"उपयोगकर्ता का प्रश्न: {user_message}\n\n"
                    f"निर्देश: ऊपर दिए गए संदर्भ के आधार पर उपयोगकर्ता के प्रश्न का सीधा, व्यावहारिक और कानूनी रूप से सही उत्तर हिंदी (देवनागरी) में प्रदान करें। प्रश्न के वास्तविक विषय (जैसे अंतरराष्ट्रीय पेटेंट कानून, पीसीटी, विदेशी फाइलिंग, या विशिष्ट फॉर्मूलेशन) को सीधे संबोधित करें और केवल प्रासंगिक कानूनी प्रावधानों का उल्लेख करें।"
                )
                messages.append({"role": "user", "content": combined})
            else:
                combined = (
                    f"{system_prompt}\n\n"
                    f"User Query: {user_message}\n\n"
                    f"Instruction: Provide a direct, helpful, and legally grounded advisory answering the user's specific inquiry based on the context above. Directly address the exact topic asked (e.g. international patent law, PCT, foreign filing, biopiracy defense, export licensing, or domestic patentability) using the relevant legal provisions without forcing unrelated statutes."
                )
                messages.append({"role": "user", "content": combined})
        else:
            if not messages:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": user_message})

        inputs = self.tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_tensors="pt",
            return_dict=True,
        ).to(self.model.device)

        return inputs

    def generate(self, system_prompt: str, user_message: str, max_tokens: int = 1024, is_hindi: bool = False, is_out_of_domain: bool = False, history: Optional[List[Dict]] = None, is_translation: bool = False, target_lang: str = "hi") -> str:
        """Generate response with loaded LLM."""
        if not self.loaded:
            return "Error: LLM not loaded."

        inputs = self.prepare_inputs(system_prompt, user_message, is_hindi=is_hindi, is_out_of_domain=is_out_of_domain, history=history, is_translation=is_translation, target_lang=target_lang)
        input_len = inputs["input_ids"].shape[1]

        with torch.inference_mode():
            output = self.model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                temperature=0.55,
                top_p=0.90,
                top_k=50,
                repetition_penalty=1.08,
                do_sample=True,
                use_cache=True,
            )

        response = self.tokenizer.decode(
            output[0][input_len:], skip_special_tokens=True
        )
        return response.strip()

    def cleanup(self):
        """Release LLM from GPU."""
        print("  Cleaning up LLM...", flush=True)
        if self.model is not None:
            del self.model
            self.model = None
        if self.tokenizer is not None:
            del self.tokenizer
            self.tokenizer = None
        cleanup_gpu()
        self.loaded = False
        print("  ✓ LLM cleaned up", flush=True)


# ============================================================
# CELL 6: ASR MANAGER
# ============================================================

class ASRManager:
    """Manages faster-whisper for speech-to-text."""

    def __init__(self):
        self.whisper = None
        self.loaded = False

    def load(self, device="cuda:0"):
        """Load faster-whisper-small."""
        print(f"  Loading faster-whisper-small on {device}...", flush=True)
        vram_report("pre-whisper")

        from faster_whisper import WhisperModel
        compute_type = "float16" if "cuda" in device else "int8"
        self.whisper = WhisperModel(
            "small",
            device=device.split(":")[0],  # "cuda" not "cuda:0"
            device_index=int(device.split(":")[-1]) if ":" in device else 0,
            compute_type=compute_type,
        )
        self.loaded = True
        print(f"  ✓ Whisper loaded", flush=True)
        vram_report("post-whisper")

    def transcribe(self, audio_bytes: bytes, language: str = None) -> dict:
        """Transcribe audio. Returns {text, language, duration}."""
        if not self.loaded:
            return {"text": "", "language": "unknown", "error": "ASR not loaded"}

        # Detect webm/opus container from browser MediaRecorder
        suffix = ".webm" if audio_bytes.startswith(b"\x1a\x45\xdf\xa3") or b"webm" in audio_bytes[:50].lower() else ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        try:
            segments, info = self.whisper.transcribe(
                tmp_path,
                language=language,
                beam_size=5,
                vad_filter=True,
            )
            full_text = " ".join(seg.text.strip() for seg in segments)
            return {
                "text": full_text,
                "language": info.language,
                "language_probability": round(info.language_probability, 3),
                "duration": round(info.duration, 2),
            }
        finally:
            os.unlink(tmp_path)

    def cleanup(self):
        """Release Whisper from GPU."""
        print("  Cleaning up Whisper...", flush=True)
        if self.whisper is not None:
            del self.whisper
            self.whisper = None
        cleanup_gpu()
        self.loaded = False
        print("  ✓ Whisper cleaned up", flush=True)


# ============================================================
# CELL 6B: OMNIVOICE TTS MANAGER
# ============================================================

class OmniVoiceTTSManager:
    """Manages k2-fsa/OmniVoice for text-to-speech.
    ~2.5GB VRAM, cross-lingual (Hindi+English), ~2s latency.
    Adapted from gemma+omnivoice reference project.
    """

    def __init__(self):
        self.model = None
        self.loaded = False
        self.device = "cuda:0"
        self.nfe_steps = 16           # Sweet spot for speed vs quality
        self.generation_speed = 1.0
        self.cfg_strength = 2.0
        self.t_shift = 0.1
        self.instruct = "female, young adult, moderate pitch, Indian accent"

    def load(self, device="cuda:0"):
        """Load OmniVoice model."""
        from omnivoice import OmniVoice as OVModel
        import wave

        self.device = device
        gpu_idx = int(device.split(":")[-1]) if ":" in device else 0
        print(f"  Loading OmniVoice TTS on {device}...", flush=True)
        vram_report("pre-omnivoice")

        # Download model files with wget (bypasses HF library hang on Kaggle)
        ov_dir = "/kaggle/working/omnivoice_model"
        ov_audio_dir = os.path.join(ov_dir, "audio_tokenizer")
        os.makedirs(ov_audio_dir, exist_ok=True)

        HF_BASE = "https://huggingface.co/k2-fsa/OmniVoice/resolve/main"
        files_to_download = [
            ("config.json", ov_dir),
            ("model.safetensors", ov_dir),
            ("tokenizer.json", ov_dir),
            ("tokenizer_config.json", ov_dir),
            ("chat_template.jinja", ov_dir),
            ("audio_tokenizer/config.json", ov_audio_dir),
            ("audio_tokenizer/model.safetensors", ov_audio_dir),
            ("audio_tokenizer/preprocessor_config.json", ov_audio_dir),
        ]

        hf_header = f"Authorization: Bearer {HF_TOKEN}" if HF_TOKEN else ""
        for fname, dest_dir in files_to_download:
            basename = fname.split("/")[-1]
            dest_path = os.path.join(dest_dir, basename)
            if os.path.exists(dest_path):
                print(f"    [cached] {fname}", flush=True)
                continue
            url = f"{HF_BASE}/{fname}"
            print(f"    [downloading] {fname}...", flush=True)
            header_arg = f'--header="{hf_header}"' if hf_header else ""
            ret = os.system(f'wget -q --timeout=60 --tries=3 {header_arg} -O "{dest_path}" "{url}"')
            if ret != 0:
                os.system(f'wget --timeout=60 --tries=3 {header_arg} -O "{dest_path}" "{url}"')

        # Heartbeat during model load
        _done = threading.Event()
        t_start = time.time()
        def _heartbeat():
            while not _done.is_set():
                _done.wait(15)
                if not _done.is_set():
                    elapsed = time.time() - t_start
                    print(f"    ... OmniVoice loading ({elapsed:.0f}s)", flush=True)
        hb = threading.Thread(target=_heartbeat, daemon=True)
        hb.start()

        try:
            self.model = OVModel.from_pretrained(
                ov_dir,
                device_map=device,
                dtype=torch.float16
            )
            # Direct inference mode (torch.compile on wrapper causes 'does not support len()')
            print("    OmniVoice: loaded in native fp16 inference mode", flush=True)

            self.loaded = True
            elapsed = time.time() - t_start
            print(f"  OmniVoice loaded in {elapsed:.1f}s", flush=True)
            vram_report("post-omnivoice")

            # Warm-up pass to trigger CUDA kernel compilation
            try:
                from omnivoice import OmniVoiceGenerationConfig
                warmup_config = OmniVoiceGenerationConfig(
                    num_step=8, guidance_scale=1.0,
                    denoise=False, preprocess_prompt=False, postprocess_output=False,
                )
                with torch.inference_mode():
                    _ = self.model.generate(text="Hello.", generation_config=warmup_config)
                print("    OmniVoice warm-up done", flush=True)
            except Exception as e:
                print(f"    OmniVoice warm-up skipped: {e}", flush=True)

            return True
        except Exception as e:
            print(f"  OmniVoice FAILED: {e}", flush=True)
            import traceback
            traceback.print_exc()
            self.model = None
            self.loaded = False
            cleanup_gpu(gpu_idx)
            return False
        finally:
            _done.set()
            hb.join(timeout=2)

    @torch.inference_mode()
    def synthesize(self, text: str, language: str = "auto") -> bytes:
        """Convert text to speech using OmniVoice. Returns WAV bytes."""
        import wave as _wave
        import io
        import re
        from omnivoice import OmniVoiceGenerationConfig

        if not self.loaded or not self.model:
            raise RuntimeError("OmniVoice not loaded")

        # 1. Clean markdown and structural formatting
        clean = re.sub(r'[*#_`§\[\]]', '', text)
        clean = re.sub(r'^[*\-+]\s+', '', clean, flags=re.MULTILINE)
        clean = re.sub(r'\s+', ' ', clean).strip()

        # 2. Extract concise spoken summary if text is a large unchunked response
        if len(clean) > 350:
            match = re.search(r'([.!?।\n])', clean[150:])
            if match:
                clean = clean[:150 + match.end()].strip()
            else:
                clean = clean[:350].strip()

        # 3. Detect language (native Devanagari vs English)
        is_hi = (language in ("hi", "Hindi", "hi-IN")) or any('\u0900' <= ch <= '\u097f' for ch in clean)
        if is_hi:
            # Convert any Romanized Hindi tokens into authentic Devanagari script so OmniVoice prosody is authentic
            clean = _romanized_hindi_to_devanagari(clean)
        target_lang = "Hindi" if is_hi else "English"

        gen_config = OmniVoiceGenerationConfig(
            num_step=16,
            guidance_scale=self.cfg_strength,
            t_shift=self.t_shift,
            layer_penalty_factor=5.0,
            position_temperature=5.0,
            class_temperature=0.0,
            audio_chunk_duration=30.0,
            audio_chunk_threshold=60.0,
            denoise=True,
            preprocess_prompt=True,
            postprocess_output=True,
        )

        audio_result = self.model.generate(
            text=clean,
            language=target_lang,
            generation_config=gen_config,
            speed=self.generation_speed,
        )

        # Convert to numpy
        if isinstance(audio_result, torch.Tensor):
            audio_np = audio_result.detach().cpu().float().numpy()
        elif isinstance(audio_result, np.ndarray):
            audio_np = audio_result
        else:
            audio_np = np.array(audio_result, dtype=np.float32)

        if audio_np.ndim > 1:
            audio_np = audio_np.squeeze()
        if audio_np.ndim > 1:
            audio_np = audio_np[0]

        # Get sample rate
        try:
            sr = self.model.sampling_rate
        except AttributeError:
            sr = 24000

        # Float [-1,1] -> int16 WAV
        audio_int16 = np.clip(audio_np, -1.0, 1.0)
        audio_int16 = (audio_int16 * 32767).astype(np.int16)
        buf = io.BytesIO()
        with _wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(audio_int16.tobytes())
        buf.seek(0)
        return buf.read()

    def cleanup(self):
        """Release OmniVoice from GPU."""
        print("  Cleaning up OmniVoice...", flush=True)
        if self.model is not None:
            del self.model
            self.model = None
        cleanup_gpu()
        self.loaded = False
        print("  OmniVoice cleaned up", flush=True)


# ============================================================
# CELL 6C: HINDI DEVANAGARI TRANSLITERATION & SCRIPT CONVERTER
# Prevents OmniVoice phoneme clashes / bliberish when Roman Hindi is spoken
# ============================================================

_ROMAN_TO_DEVANAGARI = {
    # Pronouns
    'main': 'मैं', 'mein': 'में', 'mai': 'मैं', 'hum': 'हम', 'tum': 'तुम',
    'aap': 'आप', 'yeh': 'यह', 'ye': 'ये', 'woh': 'वो', 'wo': 'वो',
    'isko': 'इसको', 'usko': 'उसको', 'inhe': 'इन्हें', 'unhe': 'उन्हें',
    'mujhe': 'मुझे', 'tumhe': 'तुम्हें', 'hamein': 'हमें', 'mere': 'मेरे',
    'mera': 'मेरा', 'meri': 'मेरी', 'tera': 'तेरा', 'teri': 'तेरी',
    'tumhara': 'तुम्हारा', 'tumhari': 'तुम्हारी', 'apna': 'अपना',
    'apni': 'अपनी', 'apne': 'अपने', 'unka': 'उनका', 'unki': 'उनकी',
    'inka': 'इनका', 'inki': 'इनकी', 'uska': 'उसका', 'uski': 'उसकी',
    'iska': 'इसका', 'iski': 'इसकी', 'humara': 'हमारा', 'hamari': 'हमारी',
    'koi': 'कोई', 'kuch': 'कुछ', 'sab': 'सब', 'sabhi': 'सभी',
    # Postpositions & particles
    'ka': 'का', 'ki': 'की', 'ke': 'के', 'ko': 'को', 'se': 'से',
    'par': 'पर', 'pe': 'पे', 'tak': 'तक', 'ne': 'ने',
    'wala': 'वाला', 'wali': 'वाली', 'wale': 'वाले',
    # Conjunctions & adverbs
    'aur': 'और', 'ya': 'या', 'lekin': 'लेकिन', 'magar': 'मगर',
    'toh': 'तो', 'to': 'तो', 'bhi': 'भी',
    'nahi': 'नहीं', 'nai': 'नहीं', 'nahin': 'नहीं', 'na': 'ना',
    'agar': 'अगर', 'jab': 'जब', 'tab': 'तब', 'abhi': 'अभी',
    'phir': 'फिर', 'fir': 'फिर', 'isliye': 'इसलिए', 'kyunki': 'क्योंकि',
    'kyuki': 'क्योंकि', 'jaise': 'जैसे', 'waise': 'वैसे',
    'sirf': 'सिर्फ', 'bas': 'बस', 'bilkul': 'बिल्कुल',
    # Verbs (common forms)
    'hai': 'है', 'hain': 'हैं', 'ho': 'हो', 'hota': 'होता', 'hoti': 'होती',
    'hote': 'होते', 'tha': 'था', 'thi': 'थी', 'the': 'थे',
    'kar': 'कर', 'karna': 'करना', 'karte': 'करते', 'karti': 'करती',
    'karta': 'करता', 'kare': 'करे', 'karein': 'करें', 'kiya': 'किया',
    'kiye': 'किये', 'karke': 'करके', 'karega': 'करेगा', 'karegi': 'करेगी',
    'hoga': 'होगा', 'hogi': 'होगी', 'honge': 'होंगे',
    'de': 'दे', 'dena': 'देना', 'dete': 'देते', 'deti': 'देती',
    'deta': 'देता', 'diya': 'दिया', 'diye': 'दिए',
    'le': 'ले', 'lena': 'लेना', 'lete': 'लेते', 'leti': 'लेती',
    'leta': 'लेता', 'liya': 'लिया', 'liye': 'लिए',
    'ja': 'जा', 'jana': 'जाना', 'jate': 'जाते', 'jati': 'जाती',
    'jata': 'जाता', 'gaya': 'गया', 'gayi': 'गई', 'gaye': 'गए',
    'jayega': 'जाएगा', 'jayegi': 'जाएगी',
    'aa': 'आ', 'aana': 'आना', 'aate': 'आते', 'aati': 'आती',
    'aata': 'आता', 'aaya': 'आया', 'aayi': 'आई', 'aaye': 'आए',
    'raha': 'रहा', 'rahi': 'रही', 'rahe': 'रहे', 'rehta': 'रहता',
    'rehti': 'रहती', 'rehte': 'रहते',
    'sakta': 'सकता', 'sakti': 'सकती', 'sakte': 'सकते',
    'chahiye': 'चाहिए', 'chahte': 'चाहते', 'chahti': 'चाहती',
    'padta': 'पड़ता', 'padti': 'पड़ती', 'padega': 'पड़ेगा',
    'bol': 'बोल', 'bola': 'बोला', 'boli': 'बोली', 'bolte': 'बोलते',
    'dekh': 'देख', 'dekha': 'देखा', 'dekhi': 'देखी', 'dekhte': 'देखते',
    'sun': 'सुन', 'suna': 'सुना', 'suni': 'सुनी', 'sunte': 'सुनते',
    'samajh': 'समझ', 'samjha': 'समझा', 'samajhte': 'समझते',
    'mil': 'मिल', 'mila': 'मिला', 'mili': 'मिली', 'milte': 'मिलते',
    'lag': 'लग', 'lagta': 'लगता', 'lagti': 'लगती', 'lagte': 'लगते',
    'baat': 'बात', 'kaam': 'काम', 'pata': 'पता', 'chala': 'चला',
    # Question words
    'kya': 'क्या', 'kaise': 'कैसे', 'kaisa': 'कैसा', 'kaisi': 'कैसी',
    'kab': 'कब', 'kahan': 'कहाँ', 'kyun': 'क्यों', 'kyon': 'क्यों',
    'kitna': 'कितना', 'kitni': 'कितनी', 'kitne': 'कितने',
    'kaun': 'कौन', 'kon': 'कौन', 'kiska': 'किसका', 'kiski': 'किसकी',
    'konsa': 'कौनसा', 'konsi': 'कौनसी',
    # Common words
    'accha': 'अच्छा', 'bura': 'बुरा', 'bada': 'बड़ा', 'chhota': 'छोटा',
    'naya': 'नया', 'purana': 'पुराना', 'zyada': 'ज़्यादा', 'kam': 'कम',
    'bahut': 'बहुत', 'thoda': 'थोड़ा', 'sabse': 'सबसे', 'pehle': 'पहले',
    'baad': 'बाद', 'saath': 'साथ', 'yahan': 'यहाँ', 'wahan': 'वहाँ',
    'namaste': 'नमस्ते', 'dhanyavaad': 'धन्यवाद', 'shukriya': 'शुक्रिया',
    'haan': 'हाँ', 'ji': 'जी', 'theek': 'ठीक', 'sahi': 'सही',
    'aaj': 'आज', 'kal': 'कल', 'batana': 'बताना', 'batao': 'बताओ',
    'bataiye': 'बताइए', 'btayo': 'बताओ', 'sb': 'सब', 'barein': 'बारे',
    'baare': 'बारे', 'sawaal': 'सवाल', 'jawaab': 'जवाब',
    # AYUSH / Political / General domain roman words
    'pm': 'प्रधानमंत्री', 'pradhanmantri': 'प्रधानमंत्री', 'mantri': 'मंत्री',
    'modi': 'मोदी', 'narendra': 'नरेंद्र', 'bharat': 'भारत', 'india': 'भारत',
    'petent': 'पेटेंट', 'patant': 'पेटेंट', 'dawa': 'दवा', 'davai': 'दवाई',
    'aushadh': 'औषधि', 'jadibuti': 'जड़ी-बूटी', 'nuskha': 'नुस्खा',
    'dhara': 'धारा', 'adhiniyam': 'अधिनियम'
}


def _romanized_hindi_to_devanagari(text: str) -> str:
    """Post-process text: convert Roman Hindi words to Devanagari script so OmniVoice produces authentic prosody without gibberish."""
    if not text:
        return ""
    words = text.split()
    result = []
    for word in words:
        stripped = word.rstrip('.,!?;:\'\"()।॥')
        suffix = word[len(stripped):]
        lower = stripped.lower()
        if lower in _ROMAN_TO_DEVANAGARI:
            result.append(_ROMAN_TO_DEVANAGARI[lower] + suffix)
        else:
            result.append(word)
    return ' '.join(result)


# ============================================================
# CELL 7: RAG PIPELINE (WIRES EVERYTHING)
# ============================================================

def is_hindi_query(text: str) -> bool:
    """Detect if query is in Hindi (Devanagari) or Hinglish (transliterated Hindi)."""
    if not text:
        return False
    # 1. Devanagari Unicode range
    for ch in text:
        if '\u0900' <= ch <= '\u097f':
            return True
    # 2. Common Hinglish transliteration keywords
    hinglish_words = {
        'kya', 'hai', 'hain', 'ke', 'ki', 'ko', 'ka', 'me', 'mein', 'se', 'sb', 'sab',
        'btayo', 'batao', 'bataiye', 'karo', 'karein', 'baare', 'barein', 'hota', 'hoti',
        'hote', 'nahi', 'nahin', 'na', 'mat', 'liye', 'kaise', 'kaisa', 'kahan', 'kab',
        'kyun', 'kyu', 'namaste', 'namaskar', 'bhi', 'kuch', 'aur', 'karna', 'kariye',
        'kijiye', 'chahiye', 'sakta', 'sakti', 'sakte', 'btao'
    }
    words = set(re.findall(r'[a-zA-Z]+', text.lower()))
    matches = words.intersection(hinglish_words)
    return len(matches) >= 2 or (len(words) <= 6 and len(matches) >= 1)


SYSTEM_PROMPT_EN = """You are AYUSH-IPR GUARDIAN, a warm, supportive, and expert AI legal assistant for Indian Traditional Medicine (AYUSH) and Intellectual Property Law.

IMPORTANT: Always respond in the SAME LANGUAGE the user writes in. If they write in Hindi, respond in Hindi. If in English, respond in English. If in Tamil or any other language, respond in that language.

BEHAVIOR:
- Be helpful, friendly, encouraging, and use clear simple language. Welcome greetings warmly.
- Directly answer the specific question asked using the relevant legal provisions from the context below.
- For international patent questions: Explain PCT, Paris Convention, Section 39 Foreign Filing License, TKDL agreements.
- For domestic patentability: Cite Section 3(j), 3(p), 3(e), 3(d) of Patents Act 1970 as relevant.
- For export/licensing: Cite D&C Act 1940, Schedule T GMP, Rule 161B, NBA approvals.
- Only cite provisions directly relevant to the question — do NOT force-cite unrelated sections.
- Precedent Disambiguation Rules:
  * Turmeric Patent Revocation: USPTO Patent 5,401,504 (wound healing) revoked in 1997 after CSIR challenge citing Charaka Samhita, Sushruta Samhita, and JIMA.
  * Neem Patent Revocation: EPO Patent 436,257 (fungicide) revoked in 2000 after EPO opposition.
  * Divya Pharmacy v. Union of India (2018 Uttarakhand HC): Strictly about Biological Diversity Act 2002 Sections 7 & 21 (Fair and Equitable Benefit Sharing / ABS for Indian entities). NEVER conflate with turmeric or patent revocation.
  * Novartis v. Union of India (2013 SC): Strictly about Section 3(d) therapeutic efficacy.
- End legal evaluations with: "Disclaimer: This is statutory information, not formal legal advice. Consult a patent attorney for filing."
- If a query is completely off-topic (coding, sports, gossip): politely decline in 1-2 sentences and invite AYUSH/IPR questions.

STATUTORY CONTEXT:
{context}"""


SYSTEM_PROMPT_HI = """आप AYUSH-IPR GUARDIAN हैं — भारतीय पारंपरिक चिकित्सा (AYUSH) और बौद्धिक संपदा कानून के सहायक AI कानूनी सलाहकार।

महत्वपूर्ण: उपयोगकर्ता जिस भाषा में लिखे उसी भाषा में उत्तर दें। हिंदी में प्रश्न हो तो हिंदी में उत्तर दें।

व्यवहार:
- विनम्र, सहायक और स्पष्ट भाषा में उत्तर दें। अभिवादन का स्वागत करें।
- प्रश्न का सीधा कानूनी उत्तर दें — केवल प्रासंगिक धाराएं बताएं।
- कानूनी नज़ीरें (Precedents) स्पष्ट रखें:
  * हल्दी (Turmeric) पेटेंट निरस्तीकरण: USPTO पेटेंट 5,401,504 (घाव भरना), जिसे 1997 में CSIR ने चरक संहिता और सुश्रुत संहिता के आधार पर रद्द कराया।
  * दिव्या फार्मेसी मामला (2018): जैव विविधता अधिनियम, 2002 की धारा 7 और 21 (लाभ साझाकरण - ABS) से संबंधित है। इसका हल्दी पेटेंट से कोई संबंध नहीं है।
  * नोवार्टिस मामला (2013): धारा 3(d) उपचारात्मक प्रभावकारिता (Therapeutic Efficacy) से संबंधित है।
- अंतरराष्ट्रीय प्रश्न: PCT, पेरिस कन्वेंशन, धारा 39, TKDL समझौते।
- पेटेंट योग्यता: धारा 3(j), 3(p), 3(e), 3(d) — जो प्रासंगिक हो।
- निर्यात/लाइसेंसिंग: D&C Act 1940, शेड्यूल T, नियम 161B, NBA।
- असंबंधित धाराएं जबरन न थोपें।
- अनुवर्ती प्रश्नों में बातचीत को आगे बढ़ाएं, नए सिरे से न शुरू करें।
- कानूनी धाराओं के नाम मूल रूप में रखें (Section 3(p), Patents Act 1970, PCT)।
- अंत में: "अस्वीकरण: यह वैधानिक जानकारी है, औपचारिक कानूनी सलाह नहीं। पेटेंट अटॉर्नी से परामर्श करें।"
- अप्रासंगिक प्रश्न: 1-2 वाक्यों में आयुष प्रश्न पूछने को कहें।

STATUTORY CONTEXT:
{context}"""


OUT_OF_DOMAIN_RESPONSE_HI = (
    "यह प्रश्न पारंपरिक चिकित्सा (AYUSH) या बौद्धिक संपदा कानून के कार्यक्षेत्र से असंबंधित है।\n\n"
    "AYUSH-IPR GUARDIAN पारंपरिक चिकित्सा, जड़ी-बूटियों, पेटेंट योग्यता (Patents Act 1970 की धारा 3(p), 3(j), 3(d), 3(e)), "
    "TKDL पूर्व कला, NBA अनुमोदन, तथा औषधि एवं प्रसाधन सामग्री अधिनियम 1940 के लिए अधिकृत है।\n\n"
    "कृपया आयुष सूत्रीकरण, जड़ी-बूटी पेटेंट या पारंपरिक ज्ञान से संबंधित प्रश्न पूछें।"
)

OUT_OF_DOMAIN_RESPONSE_EN = (
    "This inquiry appears outside the scope of AYUSH traditional medicine and intellectual property law.\n\n"
    "AYUSH-IPR GUARDIAN is specialized in advising on traditional medicine, herbs, formulation patentability "
    "(Patents Act 1970 Section 3(p) traditional knowledge, Section 3(j) plant exclusions, Section 3(d) efficacy, Section 3(e) synergy), "
    "TKDL prior art, NBA approvals, and Drugs & Cosmetics Act compliance.\n\n"
    "Please submit an inquiry pertaining to AYUSH formulation patentability, prior art, or regulatory compliance."
)

OUT_OF_DOMAIN_PROMPT_HI = """आप AYUSH-IPR GUARDIAN हैं। 1-2 विनम्र वाक्यों में बताएं कि यह प्रश्न पारंपरिक चिकित्सा या पेटेंट कानून के दायरे से बाहर है, और उपयोगकर्ता को आयुष पेटेंट या विनियामक अनुपालन से संबंधित प्रश्न पूछने के लिए आमंत्रित करें।"""

OUT_OF_DOMAIN_PROMPT_EN = """You are AYUSH-IPR GUARDIAN. In 1-2 polite sentences, explain that this inquiry is outside the scope of AYUSH traditional medicine and patent law, and invite the user to ask an AYUSH patent or regulatory question."""

# Default backward compatibility
SYSTEM_PROMPT = SYSTEM_PROMPT_EN


def is_ayush_ipr_query(query: str) -> bool:
    """Determine whether the query pertains to AYUSH traditional medicine, intellectual property, or regulatory law.
    Permissive filter: Accepts all queries touching traditional medicine, herbs,
    plants, patents, law, formulations, health, and general inquiries.
    Only intercepts unambiguously off-topic non-domain requests (e.g., coding, sports).
    """
    if not query or not query.strip():
        return False
    q = query.lower()

    # Greetings and conversational queries are always allowed
    if is_simple_greeting(q):
        return True

    # High-confidence domain stems (matches partial words, typos, and Hinglish)
    domain_stems = [
        'patent', 'paten', 'patr', 'dhara', 'dhaara', 'adhiniyam', 'rule', 'act', 'sec', 'claim',
        'tkdl', 'ipr', 'csir', 'nba', 'abs', 'wipo', 'ipo', 'uspto', 'epo',
        'ayush', 'ayur', 'unani', 'siddha', 'homeo', 'homoeo', 'sowa',
        'herb', 'plant', 'podh', 'paudh', 'flora', 'phyto', 'extract', 'formulat', 'composit',
        'admix', 'synerg', 'novel', 'efficac', 'bioavail', 'bioenhanc', 'piperine',
        'medicin', 'drug', 'dawa', 'davai', 'dawai', 'aushadh', 'jadi', 'buti', 'jadibut',
        'tradition', 'knowledg', 'prior art', 'priorart', 'gmp', 'licen',
        'ashwagandh', 'ashwagand', 'turmeric', 'haldi', 'neem', 'tulsi', 'curcumin', 'triphala', 'amla',
        'guduchi', 'giloy', 'brahmi', 'shatavari', 'shilajit', 'guggul', 'chyawanprash',
        'bhasma', 'churna', 'rasayana', 'kwath', 'taila', 'asava', 'arishta', 'vati', 'ghrita',
        'charak', 'sushrut', 'samhita', 'nighantu', 'vaidya', 'hakim', 'nuskha',
        '3(p)', '3(d)', '3(e)', '3(j)', '3(h)', '3(i)', '3p', '3d', '3e', '3j', 'section 3', 'section 25'
    ]
    if any(stem in q for stem in domain_stems):
        return True

    # Devanagari detection
    for ch in query:
        if '\u0900' <= ch <= '\u097f':
            return True

    # Explicitly off-topic triggers
    blatant_offtopic = [
        'write python', 'write java', 'write code', 'javascript code', 'c++ code', 'html code',
        'cricket score', 'ipl match', 'football score', 'who is prime minister',
        'who is president', 'weather today', 'movie ticket', 'bollywood news',
        'crypto price', 'bitcoin price', 'stock market tip', 'recipe for cake', 'recipe for pizza'
    ]
    if any(bot in q for bot in blatant_offtopic):
        return False

    # Default: allow query to proceed to RAG + LLM
    return True



def build_context_string(results: List[Dict]) -> str:
    """Build formatted context string from search results."""
    context_parts = []
    for i, r in enumerate(results, 1):
        citation = r.get("rag_config", {}).get("citation_format", r.get("doc_id", ""))
        title = r.get("title", "")
        # Compact 1200-char window prevents context window overflow and mid-sentence truncation
        content = r.get("content", "")[:1200]
        rerank = r.get("rerank_score", r.get("similarity_score", 0))

        context_parts.append(
            f"[{i}] {citation} | {title} (score:{rerank:.3f})\n{content}\n"
        )
    return "\n".join(context_parts)


def is_simple_greeting(query: str) -> bool:
    """Detect simple greetings that don't need the full RAG pipeline."""
    q = query.strip().lower()
    greetings = {
        'hi', 'hello', 'hey', 'namaste', 'namaskar', 'pranam', 'halo',
        'thanks', 'thank you', 'dhanyawad', 'shukriya',
        'bye', 'goodbye', 'alvida', 'ok', 'okay', 'theek hai',
        'good morning', 'good evening', 'good night', 'shubh prabhat',
        'how are you', 'kaise ho', 'aap kaise hain',
        'who are you', 'what are you', 'aap kaun hain', 'tum kaun ho',
        'what can you do', 'aap kya kar sakte hain'
    }
    return q in greetings


def estimate_max_tokens(query: str) -> int:
    """Adaptive token budget based on query complexity."""
    q = query.strip().lower()
    if is_simple_greeting(q):
        return 120
    words = q.split()
    # Short factual questions ("what is section 3p?", "shelf life of churna?")
    if len(words) <= 8:
        return 600
    # Medium analysis questions
    if len(words) <= 20:
        return 900
    # Comprehensive/complex queries
    return 1200


def rag_query(query: str, rag_db: RAGDatabase, llm: LLMManager, language: Optional[str] = None, history: Optional[List[Dict]] = None) -> dict:
    """Full RAG pipeline: hybrid search → cross-encoder rerank → comprehensive generate → cite."""
    t0 = time.time()
    is_hi = language == "hi" or is_hindi_query(query)
    history_list = history or []

    # Shortcut for greetings — skip RAG entirely
    if is_simple_greeting(query) and len(history_list) <= 1:
        t1 = time.time()
        greet_prompt = "आप AYUSH-IPR GUARDIAN हैं। संक्षिप्त और विनम्र हिंदी में उत्तर दें।" if is_hi else "You are AYUSH-IPR GUARDIAN, an AI assistant for Indian traditional medicine IPR law. Respond briefly and warmly in the user's language."
        answer = llm.generate(
            greet_prompt,
            query,
            max_tokens=100,
            is_hindi=is_hi,
            history=history_list
        )
        gen_time = time.time() - t1
        return {
            "query": query, "answer": answer, "citations": [], "sources": [],
            "metadata": {
                "model": llm.model_name, "engine": getattr(llm, 'engine_type', 'fp16'),
                "search_time_ms": 0, "generation_time_ms": round(gen_time * 1000),
                "total_time_ms": round(gen_time * 1000), "sources_used": 0,
                "retrieval_method": "none (greeting)",
            }
        }

    # Out-of-Domain Guardrail: Reject ALL non-AYUSH / non-legal questions immediately
    if not is_ayush_ipr_query(query) and len(history_list) <= 1:
        ood_ans = OUT_OF_DOMAIN_RESPONSE_HI if is_hi else OUT_OF_DOMAIN_RESPONSE_EN
        return {
            "query": query, "answer": ood_ans, "citations": [], "sources": [],
            "metadata": {
                "model": llm.model_name, "engine": getattr(llm, 'engine_type', 'fp16'),
                "search_time_ms": 0, "generation_time_ms": 0,
                "total_time_ms": 0, "sources_used": 0,
                "retrieval_method": "none (out of domain - rejected)",
            }
        }

    q_clean = query.strip().lower()
    words = q_clean.split()
    is_translation = (
        len(words) <= 6 and
        any(w in q_clean for w in ['hindi', 'translate', 'translation', 'english', 'अनुवाद', 'हिंदी', 'अंग्रेजी']) and
        (len(history_list) > 0)
    )

    if is_translation:
        target_lang = "hi" if (any(w in q_clean for w in ['hindi', 'हिंदी']) or language == "hi") else "en"
        is_hi = (target_lang == "hi")
        results = []
        search_time = 0
        max_tok = estimate_max_tokens(query)
        t1 = time.time()
        answer = llm.generate("", query, max_tokens=max_tok, is_hindi=is_hi, history=history_list, is_translation=True, target_lang=target_lang)
        gen_time = time.time() - t1
    else:
        last_user_query = ""
        for m in reversed(history_list):
            if m.get("role") == "user" and m.get("content") != query:
                last_user_query = m.get("content", "")
                break

        is_followup = (
            len(words) <= 6 and
            any(w in q_clean for w in ['aur', 'more', 'detail', 'batao', 'point', 'kyu', 'kaise', 'english', 'bataiye', 'explain', 'samjhao', 'continue']) and
            (last_user_query != "")
        )

        search_query = query
        if is_followup and last_user_query:
            search_query = f"{last_user_query} {query}"

        # Step 1: Hybrid search → rerank (top-6 for rich statutory context)
        results = rag_db.hybrid_search(search_query, top_k=6)
        search_time = time.time() - t0

        # Filter empty results
        results = [r for r in results if len(r.get('content', '')) > 50]
        if not results:
            results = rag_db.hybrid_search(search_query, top_k=6)

        # Step 2: Build rich context
        context = build_context_string(results)

        # Step 3: Full token budget + generate
        max_tok = estimate_max_tokens(query)
        t1 = time.time()
        sys_prompt = SYSTEM_PROMPT_HI if is_hi else SYSTEM_PROMPT_EN
        prompt = sys_prompt.format(context=context)
        answer = llm.generate(prompt, query, max_tokens=max_tok, is_hindi=is_hi, history=history_list)
        gen_time = time.time() - t1

    # Step 4: Extract citations
    citations = re.findall(r'\[([^\]]+)\]', answer)

    total_time = time.time() - t0

    return {
        "query": query,
        "answer": answer,
        "citations": citations,
        "sources": [
            {
                "doc_id": r.get("doc_id"),
                "title": r.get("title"),
                "citation": r.get("rag_config", {}).get("citation_format", ""),
                "score": r.get("rerank_score", r.get("similarity_score", 0)),
            }
            for r in results
        ],
        "metadata": {
            "model": llm.model_name,
            "engine": getattr(llm, 'engine_type', 'fp16'),
            "search_time_ms": round(search_time * 1000),
            "generation_time_ms": round(gen_time * 1000),
            "total_time_ms": round(total_time * 1000),
            "sources_used": len(results),
            "max_tokens_used": max_tok,
            "retrieval_method": "Dense(FAISS)+Sparse(BM25)+RRF→CrossEncoder",
        }
    }


# ============================================================
# CELL 8: FASTAPI APPLICATION
# ============================================================

app = FastAPI(title="AYUSH-IPR GUARDIAN", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_cors_headers_always(request, call_next):
    if request.method == "OPTIONS":
        response = Response(status_code=204)
    else:
        try:
            response = await call_next(request)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            response = JSONResponse(
                status_code=500,
                content={"error": str(exc), "detail": "Internal server error"}
            )
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Expose-Headers"] = "*"
    return response

# Global instances
rag_db = RAGDatabase()
llm = LLMManager()
asr = ASRManager()
tts = OmniVoiceTTSManager()
server_start_time = datetime.now().isoformat()
models_ready = False  # Set True once LLM + RAG are loaded (chat-ready)
current_boot_step = "initializing"
current_boot_step_display = "Server started. Initializing Cloudflare tunnel..."

# ─── Rate Limiting ────────────────────────────────────────────
from collections import defaultdict
_rate_limit_store = defaultdict(list)  # IP -> [timestamps]
MAX_REQUESTS_PER_MINUTE = 12
MAX_QUERY_LENGTH = 2000
MAX_HISTORY_TURNS = 10
SERVER_TTL_MINUTES = 60  # Auto-shutdown after 1 hour
_last_request_time = time.time()  # Track last activity for auto-shutdown

def _check_rate_limit(client_ip: str) -> bool:
    """Returns True if request is allowed, False if rate limited."""
    global _last_request_time
    _last_request_time = time.time()
    now = time.time()
    # Clean old entries
    _rate_limit_store[client_ip] = [t for t in _rate_limit_store[client_ip] if now - t < 60]
    if len(_rate_limit_store[client_ip]) >= MAX_REQUESTS_PER_MINUTE:
        return False
    _rate_limit_store[client_ip].append(now)
    return True


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    query: str
    top_k: int = 5
    language: Optional[str] = None
    messages: Optional[List[ChatMessage]] = None


class ClassifyRequest(BaseModel):
    ingredients: List[str]
    dosage_form: Optional[str] = None


@app.get("/api/health")
async def health():
    """Health check with VRAM report and readiness status."""
    gpu_info = {}
    if torch.cuda.is_available():
        for i in range(torch.cuda.device_count()):
            alloc = torch.cuda.memory_allocated(i) / 1e9
            total = torch.cuda.get_device_properties(i).total_memory / 1e9
            gpu_info[f"gpu_{i}"] = {
                "name": torch.cuda.get_device_name(i),
                "allocated_gb": round(alloc, 2),
                "total_gb": round(total, 1),
                "free_gb": round(total - alloc, 2),
            }

    return {
        "status": "healthy" if models_ready else "loading",
        "ready": models_ready,
        "step": current_boot_step,
        "step_display": current_boot_step_display,
        "models": {
            "llm": {"loaded": llm.loaded, "name": llm.model_name},
            "embeddings": {"loaded": rag_db.embed_model is not None},
            "reranker": {"loaded": rag_db.reranker is not None},
            "asr": {"loaded": asr.loaded},
            "tts": {"loaded": tts.loaded},
            "rag_db": {"loaded": rag_db.loaded, "records": len(rag_db.records)},
        },
        "gpu": gpu_info,
        "started_at": server_start_time,
    }


@app.post("/api/shutdown")
async def shutdown():
    """Gracefully terminate Kaggle server worker and mark Gist offline."""
    print("  [SHUTDOWN] Client requested server termination. Shutting down worker...", flush=True)
    def _do_exit():
        time.sleep(1.0)
        try:
            _registry_mark_offline()
        except Exception:
            pass
        os._exit(0)
    threading.Thread(target=_do_exit, daemon=True).start()
    return {"status": "shutting_down", "message": "Kaggle server worker is terminating."}


@app.post("/api/chat")
async def chat(req: ChatRequest, request: "starlette.requests.Request" = None):
    """Main RAG chat endpoint with multi-turn context support."""
    from starlette.requests import Request as _Req
    # Rate limiting
    client_ip = "unknown"
    try:
        client_ip = request.client.host if request else "unknown"
    except Exception:
        pass
    if not _check_rate_limit(client_ip):
        raise HTTPException(429, "Rate limit exceeded. Please wait a moment.")

    if not models_ready:
        raise HTTPException(503, "Server is starting up. Models are loading, please retry in a moment.")

    # Input validation
    if not req.query or not req.query.strip():
        raise HTTPException(400, "Query cannot be empty.")
    if len(req.query) > MAX_QUERY_LENGTH:
        raise HTTPException(400, f"Query too long. Maximum {MAX_QUERY_LENGTH} characters.")

    history_dicts = []
    if req.messages:
        for m in req.messages[-MAX_HISTORY_TURNS:]:
            history_dicts.append({"role": m.role, "content": m.content})

    result = rag_query(req.query, rag_db, llm, language=req.language, history=history_dicts)
    return result


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest, request: "starlette.requests.Request" = None):
    """Streaming RAG chat endpoint — SSE (Server-Sent Events) with multi-turn context retention.
    Streams tokens as they're generated for real-time display in the app.
    """
    from transformers import TextIteratorStreamer
    import threading

    # Rate limiting
    client_ip = "unknown"
    try:
        client_ip = request.client.host if request else "unknown"
    except Exception:
        pass
    if not _check_rate_limit(client_ip):
        raise HTTPException(429, "Rate limit exceeded. Please wait a moment.")

    if not models_ready:
        raise HTTPException(503, "Server is starting up. Models are loading, please retry in a moment.")

    # Input validation
    if not req.query or not req.query.strip():
        raise HTTPException(400, "Query cannot be empty.")
    if len(req.query) > MAX_QUERY_LENGTH:
        raise HTTPException(400, f"Query too long. Maximum {MAX_QUERY_LENGTH} characters.")

    is_hi = req.language == "hi" or is_hindi_query(req.query)

    # Extract history if provided
    history_dicts = []
    if req.messages:
        for m in req.messages:
            history_dicts.append({"role": m.role, "content": m.content})

    # Shortcut for greetings — stream instant friendly greeting ONLY if no conversation history exists
    if is_simple_greeting(req.query) and len(history_dicts) <= 1:
        def stream_greeting():
            import json as _json
            import time as _time
            if is_hi:
                greeting_ans = (
                    "नमस्ते! मैं **AYUSH-IPR GUARDIAN** हूँ, भारतीय पारंपरिक चिकित्सा (आयुर्वेद, सिद्ध, यूनानी, होम्योपैथी) "
                    "और बौद्धिक संपदा कानून के लिए आपका आधिकारिक AI कानूनी सहायक।\n\n"
                    "मैं आपकी सहायता कर सकता हूँ:\n"
                    "- **पेटेंट योग्यता मूल्यांकन** (पेटेंट अधिनियम, 1970: धारा 3(p) पारंपरिक ज्ञान बार, धारा 3(j) पौधे, धारा 3(d), धारा 3(e))\n"
                    "- **फॉर्मूलेशन विनियामक वर्गीकरण** (शास्त्रीय बनाम पेटेंट/मालिकाना औषधियां)\n"
                    "- **शेड्यूल T (GMP) एवं नियम 161B अनुपालन**\n"
                    "- **TKDL पूर्व कला एवं धारा 25 पेटेंट विरोध**\n"
                    "- **अंतरराष्ट्रीय पेटेंट एवं PCT फाइलिंग** (धारा 39 विदेशी फाइलिंग लाइसेंस)\n\n"
                    "आज आप किस पारंपरिक फॉर्मूलेशन, जड़ी-बूटी या कानूनी प्रावधान की जांच करना चाहते हैं?"
                )
            else:
                greeting_ans = (
                    "Hello! I am **AYUSH-IPR GUARDIAN**, your specialized legal AI assistant for Indian Traditional Medicine "
                    "(Ayurveda, Siddha, Unani, Homeopathy) and Intellectual Property Law.\n\n"
                    "I can assist you with:\n"
                    "- **Patentability Assessments** under Patents Act, 1970 (§3(p) TK bar, §3(j) plants, §3(d) efficacy, §3(e) admixtures)\n"
                    "- **Formulation Regulatory Classification** (Classical vs Patent/Proprietary under D&C Act First Schedule)\n"
                    "- **Schedule T (GMP) & Rule 161B Shelf-life Compliance**\n"
                    "- **TKDL Prior Art & Section 25 Pre-grant / Post-grant Oppositions**\n"
                    "- **International Patents & PCT Guidance** (§39 Foreign Filing License)\n\n"
                    "What traditional formulation, herb, or legal provision would you like to examine today?"
                )
            yield f"data: {_json.dumps({'type': 'sources', 'sources': [], 'search_time_ms': 0})}\n\n"
            words = greeting_ans.split(" ")
            for w in words:
                _time.sleep(0.015)
                yield f"data: {_json.dumps({'type': 'token', 'token': w + ' '})}\n\n"
            yield f"data: {_json.dumps({'type': 'done'})}\n\n"

        return StreamingResponse(stream_greeting(), media_type="text/event-stream")

    # Out-of-Domain Guardrail: Intercept strictly off-topic questions
    if not is_ayush_ipr_query(req.query) and len(history_dicts) <= 1:
        def stream_out_of_domain():
            import json as _json
            import time as _time
            ood_ans = OUT_OF_DOMAIN_RESPONSE_HI if is_hi else OUT_OF_DOMAIN_RESPONSE_EN
            yield f"data: {_json.dumps({'type': 'sources', 'sources': [], 'search_time_ms': 0})}\n\n"
            words = ood_ans.split(" ")
            for w in words:
                _time.sleep(0.015)
                yield f"data: {_json.dumps({'type': 'token', 'token': w + ' '})}\n\n"
            yield f"data: {_json.dumps({'type': 'done'})}\n\n"

        return StreamingResponse(stream_out_of_domain(), media_type="text/event-stream")

    # Follow-up context enrichment: if user says "in hindi", "translate", "tell me more"
    q_clean = req.query.strip().lower()
    words = q_clean.split()
    is_translation = (
        len(words) <= 6 and
        any(w in q_clean for w in ['hindi', 'translate', 'translation', 'english', 'अनुवाद', 'हिंदी', 'अंग्रेजी']) and
        (len(history_dicts) > 0)
    )

    if is_translation:
        target_lang = "hi" if (any(w in q_clean for w in ['hindi', 'हिंदी']) or req.language == "hi") else "en"
        is_hi = (target_lang == "hi")
        results = []
        search_time = 0
        inputs = llm.prepare_inputs(
            "",
            req.query,
            is_hindi=is_hi,
            history=history_dicts,
            is_translation=True,
            target_lang=target_lang
        )
    else:
        last_user_query = ""
        for m in reversed(history_dicts):
            if m.get("role") == "user" and m.get("content") != req.query:
                last_user_query = m.get("content", "")
                break

        is_followup = (
            len(words) <= 6 and
            any(w in q_clean for w in ['aur', 'more', 'detail', 'batao', 'point', 'kyu', 'kaise', 'english', 'bataiye', 'explain', 'samjhao', 'continue']) and
            (last_user_query != "")
        )

        search_query = req.query
        if is_followup and last_user_query:
            search_query = f"{last_user_query} {req.query}"

        # Step 1: Hybrid search + rerank (top-6 rich context)
        t0 = time.time()
        results = rag_db.hybrid_search(search_query, top_k=6)
        results = [r for r in results if len(r.get('content', '')) > 50]
        if not results:
            results = rag_db.hybrid_search(search_query, top_k=6)
        search_time = time.time() - t0
        context = build_context_string(results)

        # Step 2: Prepare prompt + token budget
        sys_prompt = SYSTEM_PROMPT_HI if is_hi else SYSTEM_PROMPT_EN
        prompt = sys_prompt.format(context=context)
        inputs = llm.prepare_inputs(prompt, req.query, is_hindi=is_hi, history=history_dicts)

    max_tok = estimate_max_tokens(req.query)

    # Step 3: Stream tokens via TextIteratorStreamer
    streamer = TextIteratorStreamer(llm.tokenizer, skip_prompt=True, skip_special_tokens=True)

    gen_kwargs = {
        **{k: v for k, v in inputs.items()},
        "max_new_tokens": max_tok,
        "temperature": 0.55,
        "top_p": 0.90,
        "top_k": 50,
        "repetition_penalty": 1.08,
        "do_sample": True,
        "use_cache": True,
        "streamer": streamer,
    }

    # Run generation in background thread
    gen_thread = threading.Thread(target=llm.model.generate, kwargs=gen_kwargs)
    gen_thread.start()

    def generate_sse():
        """Yield SSE events as tokens arrive."""
        import json as _json
        # Send sources first
        sources = []
        for r in results:
            sources.append({
                "title": r.get("title", ""),
                "citation": r.get("rag_config", {}).get("citation_format", r.get("doc_id", "")),
                "score": round(r.get("rerank_score", r.get("similarity_score", 0)), 4),
            })
        yield f"data: {_json.dumps({'type': 'sources', 'sources': sources, 'search_time_ms': round(search_time * 1000)})}\n\n"

        # Stream tokens
        for text in streamer:
            if text:
                yield f"data: {_json.dumps({'type': 'token', 'token': text})}\n\n"

        # Done
        yield f"data: {_json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(generate_sse(), media_type="text/event-stream")


@app.post("/api/document/extract")
async def extract_document(file: UploadFile = File(...)):
    """Extract text from uploaded PDF, Image, DOCX, or TXT."""
    filename = file.filename or "uploaded_document"
    contents = await file.read()

    extracted_text = ""
    file_type = "unknown"
    num_pages = 1

    # 1. PDF Extraction
    if filename.lower().endswith(".pdf") or (file.content_type and "pdf" in file.content_type.lower()):
        file_type = "pdf"
        try:
            import io
            import pypdf
            reader = pypdf.PdfReader(io.BytesIO(contents))
            num_pages = len(reader.pages)
            pages_text = []
            total_chars = 0
            for idx, page in enumerate(reader.pages[:15]):
                txt = page.extract_text() or ""
                if txt.strip():
                    pages_text.append(f"--- Page {idx+1} ---\n{txt.strip()}")
                    total_chars += len(txt)
                    if total_chars > 12000:
                        break
            extracted_text = "\n\n".join(pages_text)
        except Exception as e:
            try:
                from pdfminer.high_level import extract_text as pdf_extract
                import io
                extracted_text = pdf_extract(io.BytesIO(contents))[:12000]
            except Exception as e2:
                extracted_text = f"Error extracting PDF: {e} | {e2}"

    # 2. Image OCR Extraction
    elif any(filename.lower().endswith(ext) for ext in [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"]) or (file.content_type and "image" in file.content_type.lower()):
        file_type = "image"
        try:
            import io
            from PIL import Image
            img = Image.open(io.BytesIO(contents))
            try:
                import pytesseract
                extracted_text = pytesseract.image_to_string(img).strip()
            except Exception:
                extracted_text = f"[Image: {filename}, dimensions: {img.width}x{img.height}, format: {img.format}]"
        except Exception as e:
            extracted_text = f"Error reading image: {e}"

    # 3. Plain text / Markdown
    elif filename.lower().endswith((".txt", ".md", ".csv", ".json")):
        file_type = "text"
        try:
            extracted_text = contents.decode("utf-8", errors="ignore")[:12000]
        except Exception as e:
            extracted_text = f"Error reading text: {e}"

    else:
        try:
            extracted_text = contents.decode("utf-8", errors="ignore")[:6000]
        except Exception:
            extracted_text = f"[Binary file {filename}, size: {len(contents)} bytes]"

    return {
        "filename": filename,
        "file_type": file_type,
        "num_pages": num_pages,
        "char_count": len(extracted_text),
        "text": extracted_text[:12000]
    }


@app.post("/api/classify")
async def classify(req: ClassifyRequest):
    """Formulation classification endpoint."""
    if not llm.loaded or not rag_db.loaded:
        raise HTTPException(500, "Models not fully loaded")

    # Build classification query
    ingredients_str = ", ".join(req.ingredients)
    query = (
        f"Classify this AYUSH formulation: Ingredients: {ingredients_str}. "
        f"Dosage form: {req.dosage_form or 'not specified'}. "
        f"Is it a Classical Medicine (First Schedule), Proprietary Medicine, "
        f"or Patent Medicine? What regulatory pathway applies?"
    )
    result = rag_query(query, rag_db, llm)
    return result


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form(None)):
    """Transcribe audio to text."""
    if not asr.loaded:
        raise HTTPException(500, "ASR not loaded")

    audio_bytes = await audio.read()
    result = asr.transcribe(audio_bytes, language=language)
    return result


class TTSRequest(BaseModel):
    text: str
    language: str = "en"


@app.post("/api/tts")
async def text_to_speech(req: TTSRequest):
    """Convert text to speech using OmniVoice. Returns WAV audio."""
    if not tts.loaded:
        raise HTTPException(503, "OmniVoice TTS not loaded")

    if not req.text or not req.text.strip():
        raise HTTPException(400, "Text is required")

    # Truncate very long text to prevent GPU OOM
    text = req.text.strip()[:2000]

    try:
        t0 = time.time()
        wav_bytes = tts.synthesize(text, language=req.language)
        gen_time = time.time() - t0
        print(f"  TTS: {len(text)} chars -> {len(wav_bytes)} bytes in {gen_time:.2f}s", flush=True)

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "inline; filename=speech.wav",
                "X-TTS-Generation-Time-Ms": str(round(gen_time * 1000)),
            }
        )
    except Exception as e:
        print(f"  TTS error: {e}", flush=True)
        raise HTTPException(500, f"TTS generation failed: {str(e)}")


@app.get("/api/vram")
async def vram():
    """Get current VRAM usage."""
    gpu_info = {}
    if torch.cuda.is_available():
        for i in range(torch.cuda.device_count()):
            alloc = torch.cuda.memory_allocated(i) / 1e9
            reserved = torch.cuda.memory_reserved(i) / 1e9
            total = torch.cuda.get_device_properties(i).total_memory / 1e9
            gpu_info[f"gpu_{i}"] = {
                "name": torch.cuda.get_device_name(i),
                "allocated_gb": round(alloc, 2),
                "reserved_gb": round(reserved, 2),
                "total_gb": round(total, 1),
                "free_gb": round(total - alloc, 2),
            }
    return gpu_info


@app.post("/api/shutdown")
async def shutdown_endpoint():
    """Programmatic shutdown endpoint to conserve GPU quota when done."""
    def kill_worker():
        time.sleep(1)
        try:
            _registry_mark_offline()
        except Exception:
            pass
        os._exit(0)
    threading.Thread(target=kill_worker, daemon=True).start()
    return {"status": "shutting_down", "message": "Server instance terminating"}



# ============================================================
# CELL 9: TUNNEL SETUP
# ============================================================

def broadcast_tunnel_url(url: str):
    """Broadcast tunnel URL to cloud discovery endpoint so client app can auto-connect."""
    try:
        req = urllib.request.Request(
            "https://ntfy.sh/ayush_ipr_tunnel_sih2026",
            data=url.encode("utf-8"),
            headers={"Title": "AYUSH-IPR Server Online", "Tags": "rocket"}
        )
        urllib.request.urlopen(req, timeout=5)
        print(f"  [DISCOVERY] Broadcasted tunnel URL to discovery endpoint: {url}", flush=True)
    except Exception as e:
        print(f"  [DISCOVERY] Broadcast warning: {e}", flush=True)
    try:
        with open("/kaggle/working/tunnel_url.txt", "w") as f:
            f.write(url.strip())
    except Exception:
        pass


def start_cloudflared_tunnel(port: int) -> str:
    """Start Cloudflare Tunnel (trycloudflare.com) and return public HTTPS URL."""
    print("\n  Starting Cloudflare Tunnel (cloudflared)...", flush=True)

    cloudflared_bin = "/usr/local/bin/cloudflared"
    if not os.path.exists(cloudflared_bin):
        os.system("curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared")

    proc = subprocess.Popen(
        [cloudflared_bin, "tunnel", "--url", f"http://localhost:{port}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    q = queue.Queue()
    def enqueue_output(out, q):
        for line in iter(out.readline, ''):
            q.put(line)
        out.close()

    t = threading.Thread(target=enqueue_output, args=(proc.stderr, q), daemon=True)
    t.start()

    for _ in range(600):
        try:
            line = q.get(timeout=0.1)
            match = re.search(r"(https://[a-z0-9-]+\.trycloudflare\.com)", line)
            if match:
                url = match.group(1)
                for _ in range(3):
                    print(f"\n{'=' * 60}", flush=True)
                    print(f"  CLOUDFLARE TUNNEL URL: {url}", flush=True)
                    print(f"{'=' * 60}\n", flush=True)
                print(f"  Health: {url}/api/health", flush=True)
                print(f"  Chat:   POST {url}/api/chat", flush=True)
                broadcast_tunnel_url(url)
                # Immediately push early booting URL to Gist registry so clients discover it in seconds!
                try:
                    _registry_push_url(url, status="booting")
                except Exception as e:
                    print(f"  [DISCOVERY] Early Gist push note: {e}", flush=True)
                return url
        except queue.Empty:
            continue
    return "TUNNEL_FAILED"


# ============================================================
# CELL 10: AUTO-TEST SUITE
# ============================================================

TEST_PROMPTS = [
    {
        "id": 1,
        "query": "Can I patent a traditional Ashwagandha formulation that is documented in Charaka Samhita?",
        "expected_citation": "Section 3",
        "expected_topic": "traditional knowledge",
    },
    {
        "id": 2,
        "query": "What is considered a spurious AYUSH drug under Indian law?",
        "expected_citation": "Section 33EEA",
        "expected_topic": "spurious",
    },
    {
        "id": 3,
        "query": "What is the shelf life of Churna (powder) preparations in Ayurveda?",
        "expected_citation": "Rule 161B",
        "expected_topic": "shelf life",
    },
    {
        "id": 4,
        "query": "What are the GMP requirements for manufacturing Bhasma and calcined preparations?",
        "expected_citation": "Schedule T",
        "expected_topic": "GMP",
    },
    {
        "id": 5,
        "query": "List the authoritative books recognized for the Ayurvedic system in the First Schedule.",
        "expected_citation": "First Schedule",
        "expected_topic": "authoritative",
    },
]


def run_tests():
    """Run all test prompts and validate results."""
    print("\n" + "=" * 60)
    print("  RUNNING AUTO-TEST SUITE (5 prompts)")
    print("=" * 60 + "\n", flush=True)

    results = []
    passed = 0
    failed = 0

    for test in TEST_PROMPTS:
        print(f"  TEST {test['id']}: {test['query'][:80]}...", flush=True)
        t0 = time.time()

        try:
            result = rag_query(test["query"], rag_db, llm)
            elapsed = time.time() - t0

            answer = result["answer"]
            has_citation = test["expected_citation"].lower() in answer.lower()
            has_topic = test["expected_topic"].lower() in answer.lower()
            has_disclaimer = "not legal advice" in answer.lower() or "disclaimer" in answer.lower()
            is_not_empty = len(answer) > 50

            test_passed = has_citation and has_topic and is_not_empty
            if test_passed:
                passed += 1
                status = "✓ PASS"
            else:
                failed += 1
                status = "✗ FAIL"

            print(f"    {status} ({elapsed:.1f}s)")
            print(f"    Citation found: {'✓' if has_citation else '✗'} (looking for: {test['expected_citation']})")
            print(f"    Topic found:    {'✓' if has_topic else '✗'} (looking for: {test['expected_topic']})")
            print(f"    Has disclaimer: {'✓' if has_disclaimer else '✗'}")
            print(f"    Answer length:  {len(answer)} chars")
            print(f"    Sources used:   {len(result['sources'])}")
            print(f"    Answer preview: {answer[:200]}...")
            print("", flush=True)

            results.append({
                "test_id": test["id"],
                "status": "PASS" if test_passed else "FAIL",
                "time_ms": round(elapsed * 1000),
                "citation_found": has_citation,
                "topic_found": has_topic,
                "answer_length": len(answer),
            })

        except Exception as e:
            failed += 1
            print(f"    ✗ ERROR: {e}", flush=True)
            results.append({
                "test_id": test["id"],
                "status": "ERROR",
                "error": str(e),
            })

    # VRAM after tests
    print("\n  VRAM after all tests:", flush=True)
    vram_report("post-tests")

    # Summary
    print(f"\n{'=' * 60}")
    print(f"  TEST RESULTS: {passed}/{len(TEST_PROMPTS)} PASSED, {failed} FAILED")
    print(f"  LLM Model: {llm.model_name}")
    print(f"  RAG Records: {len(rag_db.records)}")
    print(f"{'=' * 60}\n", flush=True)

    # Save results
    try:
        with open("/kaggle/working/test_results.json", "w") as f:
            json.dump(results, f, indent=2)
        print("  Test results saved to /kaggle/working/test_results.json", flush=True)
    except Exception:
        pass

    return results


# ============================================================
# CELL 11: MAIN ENTRY POINT (OPTIMIZED FOR FAST STARTUP)
# ============================================================

def _auto_shutdown_watchdog():
    """Auto-shutdown after SERVER_TTL_MINUTES of inactivity.
    Resets on each request (tracked via _last_request_time)."""
    global _last_request_time
    print(f"  [WATCHDOG] Auto-shutdown watchdog started ({SERVER_TTL_MINUTES}min inactivity timeout)", flush=True)
    while True:
        time.sleep(60)  # Check every minute
        idle_minutes = (time.time() - _last_request_time) / 60
        if idle_minutes >= SERVER_TTL_MINUTES:
            print(f"\n{'=' * 60}", flush=True)
            print(f"  [WATCHDOG] Server idle for {idle_minutes:.0f} minutes. Shutting down.", flush=True)
            print(f"{'=' * 60}", flush=True)
            # Mark offline in registry
            try:
                _registry_mark_offline()
            except Exception as e:
                print(f"  [WATCHDOG] Registry mark offline failed: {e}", flush=True)
            os._exit(0)  # Force exit


def _registry_push_url(url, status="running"):
    """Push URL to GitHub Gist registry."""
    try:
        import urllib.request as _ur
        GIST_ID = "7873aa6da8f97b2b817137dd4f2df5be"
        token = os.environ.get("GITHUB_TOKEN", "")
        if not token:
            try:
                from kaggle_secrets import UserSecretsClient
                token = UserSecretsClient().get_secret("GITHUB_TOKEN")
            except Exception:
                pass
        if not token:
            print("  [REGISTRY] GITHUB_TOKEN not available, skipping Gist push", flush=True)
            return
        now = datetime.now().isoformat() + "Z"
        from datetime import timedelta as _td
        expires = (datetime.now() + _td(minutes=SERVER_TTL_MINUTES)).isoformat() + "Z"
        data = json.dumps({"files": {"server_registry.json": {"content": json.dumps({
            "server_url": url, "status": status,
            "started_at": now, "expires_at": expires,
            "last_heartbeat": now,
            "kaggle_kernel": "vanshseth003/ayush-ipr-guardian"
        }, indent=2)}}}).encode("utf-8")
        req = _ur.Request(f"https://api.github.com/gists/{GIST_ID}", data=data, method="PATCH",
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "AYUSH-IPR"})
        with _ur.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                print(f"  [REGISTRY] ✓ Pushed URL to Gist: {url} ({status})", flush=True)
    except Exception as e:
        print(f"  [REGISTRY] Gist push failed: {e}", flush=True)


def _registry_mark_offline():
    """Mark server as offline in Gist."""
    try:
        import urllib.request as _ur
        GIST_ID = "7873aa6da8f97b2b817137dd4f2df5be"
        token = os.environ.get("GITHUB_TOKEN", "")
        if not token:
            try:
                from kaggle_secrets import UserSecretsClient
                token = UserSecretsClient().get_secret("GITHUB_TOKEN")
            except Exception:
                pass
        if not token:
            return
        data = json.dumps({"files": {"server_registry.json": {"content": json.dumps({
            "server_url": "", "status": "offline",
            "started_at": "", "expires_at": "",
            "last_heartbeat": datetime.now().isoformat() + "Z",
            "kaggle_kernel": "vanshseth003/ayush-ipr-guardian"
        }, indent=2)}}}).encode("utf-8")
        req = _ur.Request(f"https://api.github.com/gists/{GIST_ID}", data=data, method="PATCH",
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "AYUSH-IPR"})
        with _ur.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                print("  [REGISTRY] ✓ Marked offline", flush=True)
    except Exception as e:
        print(f"  [REGISTRY] Mark offline failed: {e}", flush=True)


def _registry_heartbeat_loop(url):
    """Send heartbeat to Gist every 5 minutes."""
    while True:
        time.sleep(300)  # 5 minutes
        try:
            _registry_push_url(url, status="running")
        except Exception:
            pass


def main():
    global models_ready, _last_request_time
    PORT = 8000
    _last_request_time = time.time()

    print("\n" + "=" * 60)
    print("  AYUSH-IPR GUARDIAN — Kaggle RAG Server (Fast Start)")
    print("=" * 60 + "\n", flush=True)

    # ── Initial VRAM report ──
    num_gpus = torch.cuda.device_count() if torch.cuda.is_available() else 0
    print(f"  Device: {'CUDA' if torch.cuda.is_available() else 'CPU'} | GPUs: {num_gpus}", flush=True)
    vram_report("INITIAL")

    # ── Determine GPU placement ──
    if num_gpus >= 2:
        llm_gpu = "cuda:0"
        rag_gpu = "cuda:1"
        asr_gpu = "cuda:1"
        tts_gpu = "cuda:1"
    elif num_gpus == 1:
        llm_gpu = "cuda:0"
        rag_gpu = "cuda:0"
        asr_gpu = "cuda:0"
        tts_gpu = "cuda:0"
    else:
        llm_gpu = "cpu"
        rag_gpu = "cpu"
        asr_gpu = "cpu"
        tts_gpu = "cpu"

    # ── Start Cloudflare Tunnel IMMEDIATELY in parallel ──
    tunnel_url_holder = [None]
    def run_tunnel():
        url = start_cloudflared_tunnel(PORT)
        tunnel_url_holder[0] = url
    tunnel_thread = threading.Thread(target=run_tunnel, daemon=True)
    tunnel_thread.start()

    # ── Start auto-shutdown watchdog ──
    threading.Thread(target=_auto_shutdown_watchdog, daemon=True).start()

    # ── Load models in a background thread while FastAPI starts immediately ──
    def load_all_models():
        global models_ready, current_boot_step, current_boot_step_display

        # Step 1: Load RAG database (CPU, fast)
        current_boot_step = "loading_rag_db"
        current_boot_step_display = "Loading statutory RAG database (4,678 records)..."
        print(f"\n[1/4] {current_boot_step_display}", flush=True)
        db_path = None
        search_paths = [
            "/kaggle/working/rag_database_master.json",
            "/kaggle/input/ayush-ipr-rag-database/rag_database_master.json",
            "/kaggle/input/ayush-ipr-rag-database/ayush-ipr-rag-database/rag_database_master.json",
        ]
        if os.path.exists("/kaggle/input"):
            for root, dirs, files in os.walk("/kaggle/input"):
                for fname in files:
                    if fname == "rag_database_master.json":
                        search_paths.append(os.path.join(root, fname))

        for p in search_paths:
            if os.path.exists(p):
                try:
                    with open(p, 'r', encoding='utf-8') as f:
                        recs = json.load(f)
                    if len(recs) > 500:
                        db_path = p
                        print(f"  ✓ Found database ({len(recs)} records) at: {db_path}", flush=True)
                        break
                except Exception:
                    pass

        if db_path is None:
            print("  Downloading dataset from Kaggle Hub...", flush=True)
            os.system('kaggle datasets download vanshseth003/ayush-ipr-rag-database -p /kaggle/working/ --unzip --force 2>&1 || true')
            for root, dirs, files in os.walk("/kaggle/working"):
                for fname in files:
                    if fname == "rag_database_master.json":
                        db_path = os.path.join(root, fname)
                        break

        if not db_path or not os.path.exists(db_path):
            print("  FATAL: Cannot find rag_database_master.json!", flush=True)
            return

        rag_db.load_database(db_path)

        # Step 2: Load embeddings + build index + reranker
        current_boot_step = "loading_embeddings"
        current_boot_step_display = "Loading BGE-M3 statutory embeddings on GPU 1..."
        print(f"\n[2/4] {current_boot_step_display}", flush=True)
        rag_db.load_embeddings_model(device=rag_gpu)

        current_boot_step = "building_index"
        current_boot_step_display = "Building FAISS vector & BM25 sparse hybrid index..."
        print(f"  {current_boot_step_display}", flush=True)
        rag_db.build_index()

        current_boot_step = "loading_reranker"
        current_boot_step_display = "Loading BGE-Reranker-V2 cross-encoder on GPU 1..."
        print(f"  {current_boot_step_display}", flush=True)
        rag_db.load_reranker(device=rag_gpu)
        vram_report("after-RAG")

        # Step 3: Load LLM
        current_boot_step = "loading_llm"
        current_boot_step_display = "Loading Gemma-2-2B-IT model weights on GPU 0..."
        print(f"\n[3/4] {current_boot_step_display}", flush=True)
        llm_success = llm.load(device=llm_gpu)
        if not llm_success:
            print("  ✗ FATAL: No LLM could be loaded.", flush=True)
            return
        vram_report("after-LLM")

        # ══ CHAT IS NOW READY ══
        models_ready = True
        current_boot_step = "ready"
        current_boot_step_display = "All models loaded. AI Legal Advisory ready!"
        print("\n" + "=" * 60, flush=True)
        print("  ✓ CHAT READY — LLM + RAG loaded", flush=True)
        print("=" * 60, flush=True)

        # Update Gist status to "running" now that chat is ready
        url = tunnel_url_holder[0]
        if not url:
            tunnel_thread.join(timeout=30)
            url = tunnel_url_holder[0]
        if url and url != "TUNNEL_FAILED":
            _registry_push_url(url, status="running")
            # Start heartbeat loop
            threading.Thread(target=_registry_heartbeat_loop, args=(url,), daemon=True).start()

        # Step 4: Load ASR + TTS in background (non-blocking for chat)
        print(f"\n[4/4] Loading ASR + TTS in background on {asr_gpu}...", flush=True)
        try:
            asr.load(device=asr_gpu)
        except Exception as e:
            print(f"  ASR load warning: {e}", flush=True)
        try:
            tts.load(device=tts_gpu)
        except Exception as e:
            print(f"  TTS load warning: {e}", flush=True)

        vram_report("FINAL")
        print("\n  ✓ ALL MODELS LOADED — Server fully operational", flush=True)

    # Start model loading in background
    threading.Thread(target=load_all_models, daemon=True).start()

    # ── Start FastAPI IMMEDIATELY (before models are loaded) ──
    print(f"\n  Starting FastAPI server on port {PORT} (models loading in background)...", flush=True)
    nest_asyncio.apply()
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
