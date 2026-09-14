/**
 * WAYLO — edge AI voice & vision companion.
 * Screens: Start (landing) → Main (the live loop).
 */

import { useWaylo } from "./hooks/useWaylo";
import { StartScreen } from "./components/StartScreen";
import { MainScreen } from "./components/MainScreen";
import { ErrorBanner } from "./components/ErrorBanner";

export default function App() {
  const waylo = useWaylo();

  if (waylo.screen === "start") {
    return (
      <>
        <div className="max-w-2xl mx-auto px-6 pt-4">
          <ErrorBanner errors={waylo.errors} onDismiss={waylo.dismissError} />
        </div>
        <StartScreen
          onStart={waylo.start}
          starting={waylo.live.cameraStarting}
          visionState={waylo.visionState}
          onRetryVision={waylo.retryVision}
        />
      </>
    );
  }
  return <MainScreen c={waylo} />;
}
