import { Button as SharedButton } from '@/components/ui/button'
import { SettingsHeader } from '@/components/settings/rows'
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/settings.tsx.
/** Settings tab shell routing between stage settings (Sources, Eval, Execution), Prompts, and Deployment. */
import type { StateView } from './api.ts'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
import { SettingsProvider } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'

export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string | undefined; version?: string | undefined }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const content = (() => {
    switch (group) {
      case 'source': return <SettingsProvider><SourceSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      case 'eval': return <SettingsProvider><EvalSettings version={query.version} /></SettingsProvider>
      case 'execution': return <SettingsProvider><ExecutionSettings /></SettingsProvider>
      case 'prompts': return <PromptsPage />
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
    }
  })()
  return <div className="settings-layout dt-settings">
    <nav className="settings-nav" aria-label={t('tab.settings')}>
      <div role="tablist" aria-label={t('tab.settings')} aria-orientation="vertical">
      {SETTINGS_GROUPS.map(value => <SharedButton variant="ghost" size="sm" key={value} type="button" data-slot="nav-row"
        role="tab" id={`dt-settings-${value}`} aria-selected={value === group} aria-controls="dt-settings-body"
        className={value === group ? 'active' : undefined} onClick={() => navigate(settingsRoute(value),
          true)}>{t(`settingsGroup.${value}`)}</SharedButton>)}
      </div>
    </nav>
    <div className="dt-settings-body" id="dt-settings-body" role="tabpanel" aria-labelledby={`dt-settings-${group}`}>
      <SettingsHeader title={t(`settingsGroup.${group}`)} />
      {content}
    </div>
  </div>
}
