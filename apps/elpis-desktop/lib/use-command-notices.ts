import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

/** A command notice belongs to the chat and page that produced it. */
export function useCommandNotices(
  scope: string,
  slashNotice: string,
  setSlashNotice: Dispatch<SetStateAction<string>>,
  fastOn: boolean,
) {
  const commandNoticeOwner = useRef(scope),
    fastNoticeOwner = useRef<string | null>(null);
  commandNoticeOwner.current = scope;
  useEffect(() => {
    setSlashNotice("");
  }, [scope]);
  const fastSuccess = /^Fast is (on|off)\./.exec(slashNotice);
  const visibleSlashNotice =
    fastSuccess && (fastNoticeOwner.current !== scope || (fastSuccess[1] === "on") !== fastOn) ? "" : slashNotice;
  return { commandNoticeOwner, fastNoticeOwner, fastSuccess, visibleSlashNotice };
}
