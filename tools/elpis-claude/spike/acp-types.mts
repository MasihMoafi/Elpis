// The ACP messages used by the two local probe clients.
export type ProbeReplies = {
  initialize: { protocolVersion: number; authMethods?: { id: string }[] };
  'session/new': { sessionId: string };
  'session/prompt': { stopReason: string };
};

export type ProbeMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
  params: {
    update: { sessionUpdate: string; title: string; content?: { type: string; text: string } };
    toolCall?: { title?: string };
    options: [{ kind: string; optionId: string }, ...{ kind: string; optionId: string }[]];
  };
};
