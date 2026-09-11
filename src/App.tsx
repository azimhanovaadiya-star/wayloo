/**
 * WAYLO — edge AI voice & vision companion.
 * Screens: Start (landing) → Main (the live loop).
 */

import { useWaylo } from "./hooks/useWaylo";
import { StartScreen } from "./components/StartScreen";
import { MainScreen } from "./components/MainScreen";

export default function App() {
  const waylo = useWaylo();

  if (waylo.screen === "start") {
    return <StartScreen onStart={waylo.start} />;
  }
  return <MainScreen c={waylo} />;
}