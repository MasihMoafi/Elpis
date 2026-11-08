import { createSentenceBuffer } from './speech-buffer.mts';
export type Store = ReturnType<typeof import('./love-spot-store.cts').createLoveSpot>;
export type Scene = Awaited<ReturnType<Store['read']>>['scene'];
export type Page = Scene['page'];
export type Client = Pick<import('./client.mts').DesktopClient, 'on' | 'off' | 'readThread' | 'createThread' | 'resume' | 'send' | 'interrupt' | 'settings' | 'models' | 'setServiceTier' | 'voiceStatus'>;
export type Item = import('./client-thread-list.mts').EngineItem & {
    id: string;
    phase?: string;
};
export type Entry = {
    turnId: string;
    item: Item;
};
export type SpeechEvent = {
    type: 'text';
    text: string;
} | {
    type: 'stop' | 'done';
};
export type SpeechFeed = {
    threadId: string | null;
    emit: (event: SpeechEvent) => void;
    subscribe: (listen: (event: SpeechEvent) => void | Promise<void>) => () => void;
    fail: (message: string) => void;
};
export type Writing = {
    id: string | null;
    items: Map<string, {
        raw: string;
        buffer: ReturnType<typeof createSentenceBuffer>;
    }>;
    page: Page | undefined;
    timer: NodeJS.Timeout | null;
    done: boolean;
};
export type Thread = Awaited<ReturnType<Client['readThread']>>['thread'];
export type HeartReaction = {
    threadId: string;
    itemId: string;
    portrait: string;
};
export type EngineEvent = {
    type: string;
    data: {
        method: string;
        params: {
            threadId: string;
            turnId: string;
            itemId: string;
            delta: string;
            item: Item;
            turn: {
                id: string;
                status: string;
                error?: {
                    message?: string;
                };
                items?: Item[];
            };
            willRetry?: boolean;
            error?: {
                message?: string;
            };
            message?: string;
        };
    };
};
