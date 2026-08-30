import {useContext} from "react";
import {StdoutContext} from "../components/contexts.js";

/**
 * A React hook that returns the stdout stream where Ink renders your app.
 */
const useStdout = () => useContext(StdoutContext);

export default useStdout;
