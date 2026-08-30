import {useContext} from "react";
import {StderrContext} from "../components/contexts.js";

/**
 * A React hook that returns the stderr stream.
 */
const useStderr = () => useContext(StderrContext);

export default useStderr;
