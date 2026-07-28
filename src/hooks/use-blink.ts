import { useEffect, useState } from "react";

const BLINK_INTERVAL_MS = 500;

/** Drives the text-cursor blink; returns true while the cursor should be drawn. */
export function useBlink(isEnabled: boolean): boolean {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (!isEnabled) {
      setIsVisible(true);
      return;
    }
    const timer = setInterval(() => setIsVisible((visible) => !visible), BLINK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isEnabled]);

  return isVisible;
}
