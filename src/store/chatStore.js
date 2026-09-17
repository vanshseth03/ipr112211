import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { universalStorage } from './storageHelper';

export const useChatStore = create(
  persist(
    (set, get) => ({
      messages: [],
      activeConversationId: `conv-${Date.now()}`,
      isStreaming: false,

      // Reference to the current SSE connection so we can abort it.
      // NOT persisted (transient).
      _sseConnection: null,

      addMessage: (message) =>
        set((state) => ({
          messages: [...state.messages, message],
        })),

      updateMessage: (id, patch) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id
              ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) }
              : m
          ),
        })),

      setMessages: (messages) => set({ messages }),

      clearMessages: () =>
        set({
          messages: [],
          activeConversationId: `conv-${Date.now()}`,
          isStreaming: false,
          _sseConnection: null,
        }),

      setActiveConversationId: (activeConversationId) =>
        set({ activeConversationId }),

      setIsStreaming: (isStreaming) => set({ isStreaming }),

      // Store the SSE connection ref so Stop can abort it
      setSseConnection: (conn) => set({ _sseConnection: conn }),

      // Stop the current streaming response
      stopStreaming: () => {
        const conn = get()._sseConnection;
        if (conn && typeof conn.close === 'function') {
          conn.close();
        }
        set({ isStreaming: false, _sseConnection: null });
      },

      // Start a brand new conversation
      newConversation: () =>
        set({
          messages: [],
          activeConversationId: `conv-${Date.now()}`,
          isStreaming: false,
          _sseConnection: null,
        }),
    }),
    {
      name: 'ayurveda_chat_history',
      storage: createJSONStorage(() => universalStorage),
      // Only persist activeConversationId, new sessions start fresh
      partialize: (state) => ({
        activeConversationId: state.activeConversationId,
      }),
    }
  )
);
