/* Adapted from packages/client/ui-primitives/src · Copyright (c) 2026 DeepSeek, MIT License */
import { cloneElement, type ReactElement, type ReactNode } from 'react'

// Framework seats that the standalone JSON contract does not provide.
export interface FileAttachmentRef { name?: string; bytes?: number }
export interface ImageAttachmentRef extends FileAttachmentRef { mediaType?: string; width?: number; height?: number }
export interface ConversationPromptSnapshot { system: string; tools: { name: string; description: string; parameters: object }[] }
export interface AssistantRequestConfig { provider?: string; model?: string; [key: string]: unknown }
export type MessageImageLoader = (...args: never[]) => undefined
export interface PropsRenderSlots<T extends string> { renderSlot: (name: T, props: unknown) => ReactNode }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type WatchToolResult = (seq: number, cb: (value: JsonValue | undefined) => void) => () => void
export function assertNever(value: never): never { throw new Error(`Unexpected value: ${String(value)}`) }

export interface JsonTreeLabels {
  copyValue: string; copyJson: string; copyPath: string; copyPrettyJson: string; copyCompactJson: string
  copied: string; copyFailed: string; collapseNode: string; expandNode: string; copyButtonTitle: (action: string) => string
}
export interface JsonTreeProps {
  data: unknown; label: string; labels: JsonTreeLabels; className?: string; collapsedStringLines?: number
  stringWrapping?: { getDefault: () => boolean; setDefault: (wrapped: boolean) => void }
}
export interface MarkdownLabels { code: { copyLabel: string; copiedLabel: string }; footnotes: string }
export function JsonTree({ data, label, className }: JsonTreeProps) {
  return <pre aria-label={label} className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(data, null, 2)}</pre>
}
export function MarkdownText({ text }: { text: string; labels: MarkdownLabels; variant?: 'body' | 'compact' }) {
  return <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>
}
export function CodeBlock({ code, className }: { code: string; lang?: string; lineNumbers?: boolean; showHeader?: boolean; className?: string; copyLabel: string; copiedLabel: string }) {
  return <pre className={className}><code>{code}</code></pre>
}
export function Tooltip({ children, label }: { children: ReactElement<{ title?: string }>; label: string | (() => string); side?: string; delayMs?: number }) {
  return cloneElement(children, { title: typeof label === 'function' ? label() : label })
}
export function StateDot({ state }: { state: string }) { return <span aria-hidden="true" data-state={state}>•</span> }
export function FileTypeIcon({ path }: { path: string }) { return <span aria-hidden="true">{fileExtension(path).toUpperCase()}</span> }
export function fileExtension(path: string): string { return path.split('.').pop() ?? '' }
export function fileSizeText(bytes: number | undefined): string { return bytes === undefined ? '' : `${bytes} B` }
export function extractMarkdownPlainText(text: string): string { return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_#~]/g, '') }
export async function writeClipboard(text: string): Promise<boolean> { try { await navigator.clipboard.writeText(text); return true } catch { return false } }

type IconProps = { size?: number; className?: string }
function icon(path: ReactNode) { return function Icon({ size = 16, className }: IconProps) { return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className={className} aria-hidden="true">{path}</svg> } }
export const IconSearchOutlineRegular = icon(<><circle cx="6.6" cy="6.5" r="5.3"/><path d="m10.3 10.4 4.5 4.5"/></>)
export const IconCheckOutlineRegular = icon(<path d="m2.2 8.5 3.3 3.2 1.4 0L13.8 4"/>)
export const IconChevronRightOutlineRegular = icon(<path d="m6 12 4-4-4-4"/>)
export const IconCodeOutlineRegular = icon(<path d="m6 4-4 4 4 4m4-8 4 4-4 4"/>)
export const IconWrapLinesOutlineRegular = icon(<path d="M2 3h12M2 7h9a2 2 0 0 1 0 4H9m1-2-2 2 2 2M2 11h4"/>)
export const IconCopyOutlineRegular = icon(<><rect x="2" y="4" width="10" height="10" rx="2"/><path d="M5 2h7a2 2 0 0 1 2 2v7"/></>)
export const IconSettingsOutlineRegular = icon(<><circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="5.5"/><path d="M8 1v2m0 10v2M1 8h2m10 0h2"/></>)
export const IconSparkleRegular = icon(<path d="M8 1.5c.7 3.7 2.8 5.8 6.5 6.5-3.7.7-5.8 2.8-6.5 6.5C7.3 10.8 5.2 8.7 1.5 8 5.2 7.3 7.3 5.2 8 1.5Z"/>)
export const IconUserOutlineRegular = icon(<><circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5"/></>)
