import { BrowserIcon } from "@/components/elpis-icons";
import { ImageThumb, fileKind } from "@/components/file-cards";

/** A picture the agent looked at: its name and, when the chat's media route is safe, the picture itself (nothing to fold). */
export function ImageViewStep({ path, mediaBase }: { path: string; mediaBase?: string | undefined }) {
  const name = fileKind(path).name,
    safeBase = mediaBase?.startsWith("/api/threads/") && !/[?#\\]/.test(mediaBase) ? mediaBase : null;
  return (
    <div className="activity-card">
      <div className="activity-heading">
        <span className="activity-icon">
          <BrowserIcon size={15} />
        </span>
        <span className="activity-title">Viewed an image</span>
        <span className="activity-preview" title={path}>
          {name}
        </span>
      </div>
      {safeBase && (
        <div className="px-3 pb-2">
          <ImageThumb src={`${safeBase}/0`} name={name} large />
        </div>
      )}
    </div>
  );
}
