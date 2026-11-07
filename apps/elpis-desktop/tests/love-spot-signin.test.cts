const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const { chooseOption, controlValue } = require('./controls.cjs');

type Body = { action?: string; id?: string; name?: string; baseUrl?: string; provider?: string; key?: string; credential?: { action?: string; value?: string } };
type FakeRoute = { request(): { method(): string; postDataJSON(): Body }; fulfill(response: { status: number; json: unknown }): Promise<void> };
type Account = { id: string; label: string; email: string | null; plan: string | null; authenticated: boolean; duplicate: boolean; signingIn: boolean; error: null };
type Provider = { id: string | undefined; name: string | undefined; baseUrl: string | undefined; wireApi: string; editable: boolean; auth: { source: string; keySet: boolean; envKey: null } };
type OpenRouterItem = { id: string | undefined; name: string | undefined; baseUrl: string | undefined; envKey: null; keySet: boolean };
type State = { openaiSignedIn: boolean; claudeSignedOut: boolean; claudeActiveId: string; claudeAccounts: Account[]; openrouter: OpenRouterItem[];
  providers: Provider[]; version: string; builtInKeys: Body[]; needsKeyOpenRouter: boolean };
type Commands = { __commands?: { action: string; url?: string }[] };

test('Love Spot signs in with ChatGPT, Claude subscription, OpenRouter and API keys; the standalone app offers Anthropic by key only', async () => {
  const state: State = {
    openaiSignedIn: false,
    claudeSignedOut: false,
    claudeActiveId: 'default',
    claudeAccounts: [
      { id: 'default', label: 'Default', email: 'masih@example.com', plan: 'max', authenticated: true, duplicate: false, signingIn: false, error: null },
    ],
    openrouter: [],
    providers: [],
    version: 'v1',
    builtInKeys: [],
    needsKeyOpenRouter: true,
  };

  const f = await loveSpotFixture({
    configureClient: (emitter: { settings?: () => Promise<unknown> }) => {
      emitter.settings = async () => ({
        main: { model: 'sol', provider: 'openai' },
        background: {},
        smartPrune: { enabled: false, explicitOverride: {} },
        memory: {},
        write: { available: true, reason: '' },
        agents: { graph: 256, atOnce: 4, source: 'agents.max_threads' },
        providers: [
          { id: 'openai', displayName: 'OpenAI' },
          { id: 'openrouter', displayName: 'OpenRouter', needsKey: state.needsKeyOpenRouter },
        ],
      });
    },
  });

  try {
    const { page } = f;

    await page.route('**/api/providers', async (route: FakeRoute) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body.action === 'chatgpt') {
          setTimeout(() => { state.openaiSignedIn = true; }, 400);
          return route.fulfill({ status: 200, json: { authUrl: 'https://auth.openai.com/oauth/authorize?client_id=codex', loginId: 'login-1' } });
        }
        if (body.action === 'signOut') {
          state.openaiSignedIn = false;
          return route.fulfill({ status: 200, json: { ok: true } });
        }
        if (body.action === 'anthropicSignOut') {
          state.claudeSignedOut = true;
          return route.fulfill({ status: 200, json: { ok: true } });
        }
        if (body.action === 'anthropicSignIn') {
          state.claudeSignedOut = false;
          return route.fulfill({ status: 200, json: { ok: true } });
        }
      }
      return route.fulfill({
        status: 200,
        json: {
          openai: {
            auth: state.openaiSignedIn
              ? { state: 'signedIn', method: 'chatgpt', email: 'masih@example.com', plan: 'pro', error: null }
              : { state: 'signedOut', method: null, email: null, plan: null, error: null },
            usage: [],
            usageError: null,
          },
          claude: {
            state: state.claudeSignedOut ? 'notConnected' : 'connected',
            signedOut: state.claudeSignedOut,
            models: state.claudeSignedOut ? [] : ['claude/sonnet'],
            usage: [],
          },
          gemini: { state: 'notConnected', models: [], usage: [] },
          openrouter: state.openrouter,
        },
      });
    });

    await page.route('**/api/providers/claude-accounts', async (route: FakeRoute) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body.action === 'login') {
          state.claudeAccounts = [
            state.claudeAccounts[0]!,
            { id: 'claude-2', label: 'Claude 2', email: null, plan: null, authenticated: false, duplicate: false, signingIn: true, error: null },
          ];
          return route.fulfill({
            status: 200,
            json: {
              activeId: state.claudeActiveId,
              accounts: state.claudeAccounts,
              authUrl: 'https://claude.ai/oauth/authorize?client_id=claude-code',
            },
          });
        }
        if (body.action === 'code') {
          state.claudeAccounts = [
            state.claudeAccounts[0]!,
            { id: 'claude-2', label: 'Claude 2', email: 'alt@example.com', plan: 'max', authenticated: true, duplicate: false, signingIn: false, error: null },
          ];
          state.claudeActiveId = 'claude-2';
          return route.fulfill({ status: 200, json: { activeId: state.claudeActiveId, accounts: state.claudeAccounts } });
        }
        if (body.action === 'select') {
          state.claudeActiveId = body.id ?? '';
          return route.fulfill({ status: 200, json: { activeId: state.claudeActiveId, accounts: state.claudeAccounts } });
        }
      }
      return route.fulfill({ status: 200, json: { activeId: state.claudeActiveId, accounts: state.claudeAccounts } });
    });

    await page.route('**/api/providers/settings', async (route: FakeRoute) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        const keySet = body.credential?.action === 'replace' && Boolean(body.credential?.value);
        const existing = state.providers.findIndex(p => p.id === body.id);
        const entry = {
          id: body.id,
          name: body.name,
          baseUrl: body.baseUrl,
          wireApi: 'responses',
          editable: true,
          auth: { source: keySet ? 'saved' : 'none', keySet, envKey: null },
        };
        if (existing >= 0) state.providers[existing] = entry;
        else state.providers.push(entry);
        if (body.id === 'openrouter' || body.baseUrl?.includes('openrouter.ai')) {
          state.openrouter = [{ id: body.id, name: body.name, baseUrl: body.baseUrl, envKey: null, keySet }];
        }
      }
      return route.fulfill({
        status: 200,
        json: {
          application: {
            scope: 'newSessionsOnly',
            message: 'Saved for new conversations and agents. Existing conversations keep their current provider settings.',
            credentialClearMessage: 'Cleared for new conversations.',
          },
          version: state.version,
          configPath: '/tmp/love-spot-test/config.toml',
          write: { available: true, reason: null },
          managed: { modelProvider: 'openai' },
          providers: [
            { id: 'openai', name: 'OpenAI', baseUrl: null, wireApi: 'responses', editable: false, auth: { source: 'subscription', keySet: false, envKey: null } },
            ...state.providers,
          ],
        },
      });
    });

    await page.route('**/api/providers/key', async (route: FakeRoute) => {
      const body = route.request().postDataJSON();
      state.builtInKeys.push(body);
      state.needsKeyOpenRouter = false;
      return route.fulfill({ status: 200, json: { ok: true } });
    });

    await page.route('**/api/models?provider=openrouter*', async (route: FakeRoute) => {
      return route.fulfill({
        status: 200,
        json: { data: [{ id: 'openrouter/kimi-k2', model: 'openrouter/kimi-k2', displayName: 'Kimi K2 (OpenRouter)', inputModalities: ['text', 'image'] }] },
      });
    });

    // Navigate to standalone Love Spot (/love-spot.html)
    await page.goto(f.url.replace('/#', '/love-spot.html#'));
    await page.locator('.excalidraw canvas').first().waitFor();

    // 1. Open Models & accounts from the standalone Love Spot toolbar
    const accountsBtn = page.locator('.love-spot-tools').getByRole('button', { name: 'Models & accounts', exact: true });
    await accountsBtn.waitFor();
    await accountsBtn.click();

    const dialog = page.getByRole('dialog', { name: 'Models & accounts' });
    await dialog.waitFor();

    // 2. ChatGPT subscription sign-in
    const openaiCard = dialog.locator('[data-provider="openai"]');
    assert.match(await openaiCard.innerText(), /Not signed in/);
    await openaiCard.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as Commands).__commands?.some(c => c.action === 'external-url' && c.url?.startsWith('https://auth.openai.com/oauth/authorize')));
    await openaiCard.getByText('Signed in with chatgpt').waitFor({ timeout: 6000 });
    assert.match(await openaiCard.innerText(), /masih@example\.com · pro plan/);

    // Sign out of ChatGPT
    await openaiCard.getByRole('button', { name: 'Sign out', exact: true }).click();
    await openaiCard.getByText('Not signed in').waitFor();

    // 3. Claude subscription sign-in (add account + paste code + switch + sign out/in)
    const claudeCard = dialog.locator('[data-provider="claude"]');
    await claudeCard.getByRole('button', { name: 'Add Claude account', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as Commands).__commands?.some(c => c.action === 'external-url' && c.url?.startsWith('https://claude.ai/oauth/authorize')));
    const codeInput = claudeCard.getByLabel('Claude sign-in code', { exact: true });
    await codeInput.waitFor();
    await codeInput.fill('claude-oauth-code-123');
    await claudeCard.getByRole('button', { name: 'Complete sign-in', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Claude account"]')?.getAttribute('data-value') === 'claude-2');
    await chooseOption(claudeCard.getByLabel('Claude account', { exact: true }), 'default');
    assert.equal(await controlValue(claudeCard.getByLabel('Claude account', { exact: true })), 'default');

    // Sign out of Claude in Elpis, then sign back in
    await claudeCard.getByRole('button', { name: 'Sign out', exact: true }).click();
    await claudeCard.getByText('Signed out in Elpis').waitFor();
    await claudeCard.getByRole('button', { name: 'Sign in', exact: true }).click();
    await claudeCard.getByText('Connected').waitFor();

    // 4. OpenRouter / API key form with Submit button in Models & accounts
    await dialog.locator('.provider-advanced summary').click();
    await dialog.getByRole('button', { name: 'Add API provider', exact: true }).click();
    const form = dialog.getByRole('form', { name: 'API provider settings' });
    await chooseOption(form.getByLabel('Provider type', { exact: true }), 'openrouter');
    await chooseOption(form.getByLabel('API key action', { exact: true }), 'replace');
    await form.getByLabel('Provider API key', { exact: true }).fill('sk-or-v1-local-test-key');
    await form.getByRole('button', { name: 'Save provider', exact: true }).click();
    await dialog.locator('[data-provider="openrouter"]').getByText('Key set', { exact: true }).waitFor();

    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });

    // 5. Built-in key paste directly in Love Spot's Model picker (Submit = "Save key")
    const modelCombo = page.getByRole('group', { name: "Matilda's model" }).getByRole('combobox');
    await modelCombo.click();
    await page.getByRole('tab', { name: 'OpenRouter', exact: true }).click();
    const keyForm = page.getByRole('form', { name: 'OpenRouter API key' });
    await keyForm.waitFor();
    await keyForm.getByLabel('OpenRouter API key', { exact: true }).fill('sk-or-inline-key');
    await keyForm.getByRole('button', { name: 'Save key', exact: true }).click();
    await page.getByRole('option', { name: /Kimi K2 \(OpenRouter\)/ }).waitFor();
    assert.equal(state.builtInKeys.length, 1);
    assert.equal(state.builtInKeys[0]?.provider, 'openrouter');
    await page.keyboard.press('Escape');

    // 6. The standalone app (its own home) offers Anthropic by API key only: no Claude or Gemini subscription
    // (skills/provider-login/spec.md, Claude subscription route; bridge/love-spot-talk.mts refuses those models too).
    await page.goto(f.url.replace('/#', '/love-spot.html?app=love-spot#'));
    await page.locator('.excalidraw canvas').first().waitFor();
    await page.getByRole('group', { name: "Matilda's model" }).getByRole('combobox').click();
    assert.equal(await page.getByRole('tab', { name: 'Anthropic', exact: true }).count(), 0, 'no Claude subscription models');
    await page.keyboard.press('Escape');
    await page.locator('.love-spot-tools').getByRole('button', { name: 'Models & accounts', exact: true }).click();
    const own = page.getByRole('dialog', { name: 'Models & accounts' });
    const anthropic = own.locator('[data-provider="claude"]');
    await anthropic.getByText('No key', { exact: true }).waitFor();
    assert.equal(await anthropic.getByRole('button', { name: 'Add Claude account' }).count(), 0);
    assert.equal(await own.locator('[data-provider="gemini"]').count(), 0, 'no Antigravity subscription');
    await anthropic.getByRole('textbox', { name: 'Anthropic API key', exact: true }).fill('sk-ant-local-test-key');
    const saved = page.waitForResponse((response: { url(): string }) => response.url().endsWith('/api/providers/key'));
    await anthropic.getByRole('button', { name: 'Save key', exact: true }).click();
    await saved;
    assert.deepEqual(state.builtInKeys.at(-1), { provider: 'anthropic', key: 'sk-ant-local-test-key' });

    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
