import {useContext} from "react";
import {StdinContext} from "../components/contexts.js";

/**
 * A React hook that returns the stdin stream and stdin-related utilities.
 */
const useStdin = () => useContext(StdinContext);

export const useStdinContext = () => useContext(StdinContext);

export default useStdin;
