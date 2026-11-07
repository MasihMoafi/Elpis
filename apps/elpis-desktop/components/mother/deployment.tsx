// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/deployment.tsx.
import { LIMITS } from '../../bridge/router/limits.mts'
import { usePoll, type SetupView } from './api'
import { Input } from './controls'
import { SaveBar, useDraft } from './draft'
import { usePanel } from './provider'
import { Field, Fields } from './settings-kit'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage } from './widgets'
export type DeploymentForm = undefined
const KEYS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
export function DeploymentPage({ setup, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean | undefined }) {
  const { t, call, notify } = usePanel(), { data, error, reload } = usePoll(() => call('GET deployment'), [call])
  const draft = useDraft({ saved: data?.value ?? { promptMaxChars: setup.machine.promptMaxChars, admissionContextMaxPages: setup.machine.admissionContextMaxPages, admissionContextTimeoutMs: setup.machine.admissionContextTimeoutMs },
    revision: data?.revision, reload, save: async (value, revision) => {
      const saved = await call('PUT deployment', { body: { value, revision } }); notify(t('saved')); return { ...saved, restarting: false }
    } })
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}><Fields disabled={draft.busy || !data}>
    {error && <p role="alert">{error.message}</p>}
    {setup.problem && <Section title="Setup"><SetupMessage problem={setup.problem} lead /><CheckSetupButton /></Section>}
    {showAccounts && <Section title={t('deploymentDerived')}><KeyValues rows={[[t('deploymentRepository'), setup.accounts?.repository || '—'], [t('deploymentAgent'), setup.accounts?.agent || '—']]} /></Section>}
    <Section title={t('deploymentMachine')}><Hint>{setup.machine.stateDir}</Hint></Section>
    <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
      {KEYS.map(key => <Field key={key} label={t(key === 'promptMaxChars' ? 'deploymentPromptMaxChars' : key === 'admissionContextMaxPages' ? 'deploymentContextPages' : 'deploymentContextTimeout')}>
        <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} onChange={event => draft.edit({ ...draft.value, [key]: Number(event.target.value) })} />
      </Field>)}
    </Section>
  </Fields><SaveBar {...draft} onDiscard={draft.discard} /></form>
}
