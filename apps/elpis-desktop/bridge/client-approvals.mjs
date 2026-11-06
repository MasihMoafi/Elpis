import { BridgeError, object, text } from './validate.mjs';
import { elicitationResponse, grantedPermissions, permissionsResponse } from '../lib/approvals.ts';

export { grantedPermissions };
const DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'];

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} body */
export function impl_answerApproval(clientState, id, body) {
    const pending = clientState.approvals.get(id);
    if (!pending) throw new BridgeError('Approval is no longer pending', 409);
    const input = /** @type {{ answers: Record<string, unknown>, decision: unknown }} */ (body);
    let result;
    if (pending.method === 'mcpServer/elicitation/request' || pending.method === 'item/permissions/requestApproval') {
      try { result = pending.method === 'mcpServer/elicitation/request' ? elicitationResponse(pending.params, body) : permissionsResponse(pending.params.permissions, body); }
      catch (error) { throw new BridgeError(/** @type {Error} */ (error).message); }
    } else if (pending.method === 'item/tool/requestUserInput') {
      object(input, ['answers']); const questions = pending.params.questions ?? [];
      object(input.answers, questions.map(/** @param {{ id: string }} q */ q => q.id));
      result = { answers: Object.fromEntries(questions.map(/** @param {{ id: string }} q */ q => {
        const answers = input.answers[q.id];
        if (!Array.isArray(answers) || !answers.length || answers.length > 20) throw new BridgeError('Answer each pending question');
        return [q.id, { answers: answers.map(a => text(a, 'answer', 4096)) }];
      })) };
    } else {
      object(input, ['decision']);
      // Amendments ("always allow this prefix/host") are objects; only an exact offered one is accepted.
      const offered = pending.params.availableDecisions;
      const isOffered = offered ? offered.some(/** @param {unknown} item */ item => JSON.stringify(item) === JSON.stringify(input.decision)) : DECISIONS.includes(/** @type {string} */ (input.decision));
      if (typeof input.decision === 'string' ? !DECISIONS.includes(input.decision) : !input.decision || typeof input.decision !== 'object') throw new BridgeError('Unsupported approval decision');
      if (!isOffered) throw new BridgeError('Decision is not offered for this request');
      result = { decision: input.decision };
    }
    clientState.socket.send(JSON.stringify({ id: pending.wireId, result }));
    clientState.approvals.delete(id);
    this.emit('event', { type: 'approvalResolved', data: { id } }); return { resolved: true };
  }

/** "Deny, and tell Elpis what to do instead": the instruction joins the waiting turn (turn/steer), then the command or
   * edit is declined, so the turn goes on with both. Nothing is sent unless the request offers a decline, and the card
   * stays when the turn cannot take the instruction. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} id @param {unknown} body */
export async function impl_denyInstead(clientState, id, body) {
    const pending = clientState.approvals.get(id);
    if (!pending) throw new BridgeError('Approval is no longer pending', 409);
    if (pending.method !== 'item/commandExecution/requestApproval' && pending.method !== 'item/fileChange/requestApproval') throw new BridgeError('Only a command or edit approval can be denied with an instruction');
    const input = /** @type {{ text?: unknown }} */ (object(body, ['text']));
    const instruction = typeof input.text === 'string' ? input.text.trim() : '';
    if (!instruction) throw new BridgeError('Write what Elpis should do instead');
    const offered = pending.params.availableDecisions;
    if (offered && !offered.includes('decline')) throw new BridgeError('Decision is not offered for this request');
    await this.steer(pending.params.threadId, { text: instruction, expectedTurnId: pending.params.turnId }, { fallback: false });
    return this.answerApproval(id, { decision: 'decline' });
  }
