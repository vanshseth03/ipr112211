import sys
import os
import time

sys.stdout.reconfigure(encoding='utf-8')

BANNER = """
================================================================================
   🌿  AYUSH-IPR GUARDIAN — CROSS-PLATFORM EXPO APPLICATION (v1.0.0)  🌿
================================================================================
  Connected Live Backend : https://permanent-relatively-bra-reforms.trycloudflare.com
  LLM Engine             : Gemma-2-2B-IT (float16) on Dual GPU T4
  Vector Search & RAG    : BGE-M3 + BGE-Reranker-Large (362 Statutory Sections)
  Voice & Audio Engine   : Faster-Whisper ASR (GPU Accelerated)
================================================================================

📱 APPLICATION USAGE GUIDE & KEY SCREENS:
────────────────────────────────────────────────────────────────────────────────
 1. 💬 CHAT & RAG LEGAL REASONING (/chat):
    • Multi-turn conversational legal advisory for AYUSH innovators.
    • Real-time SSE Token Streaming with interactive source citation pills.
    • Citation confidence scores (0.00 - 1.00) & expandable statutory excerpts.
    • Audio / Voice Input with Faster-Whisper ASR.

 2. 🧪 FORMULATION CLASSIFICATION WIZARD (/classify):
    • Step 1: Formulation Name & Classical Reference input.
    • Step 2: Dynamic Botanical Ingredient builder (e.g. Ashwagandha, Curcumin).
    • Step 3: Automated Regulatory Determination:
      - Classical Medicine (First Schedule compliance under D&C Act §3(a))
      - Patent or Proprietary (P&P) Medicine (§3(h) licensing pathway)
      - Schedule E(1) Poisonous Botanicals / Minerals Warning
      - Section 3(p) Traditional Knowledge Bar & Synergism verification.

 3. 📷 OCR DOCUMENT SCANNER & SPECIFICATION ANALYZER (/scan):
    • Upload or take camera captures of patent specifications / package labels.
    • Automatic text extraction & regulatory compliance checks.

 4. 🌐 JURISDICTION & MULTILINGUAL TOGGLE (/settings):
    • India (National) vs International (TRIPS, PCT, WIPO GRATK) switch.
    • Multilingual switching (English, Hindi, Tamil, and Indic scheduled languages).
    • Toggle Mock Mode or Live Kaggle API Endpoint.

 5. 📜 SESSION HISTORY & CASE LOGS (/history):
    • Persistent storage of past statutory analyses, exportable case summaries.

────────────────────────────────────────────────────────────────────────────────
🚀 EXPO LOCAL TESTING INSTRUCTIONS:
 • Press 'w' in the Expo terminal to open in your Web Browser (http://localhost:8081)
 • Press 'a' to open in Android Emulator
 • Scan the QR Code with the Expo Go App on your physical Android / iPhone
================================================================================
"""

print(BANNER, flush=True)
