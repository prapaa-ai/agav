import {type DOMElement} from "./dom.js";

// Preserve SGR sequences (colors, bold, etc. — end with `m`) and OSC sequences
// (hyperlinks, etc.), and strip cursor movement, screen clearing, and other
// control sequences that would conflict with Ink's layout. This mirrors the
// behavior of Ink's `sanitize-ansi.js` for the SGR/OSC output Ink emits.
// eslint-disable-next-line no-control-regex
const sgrSequence = /\u001B\[[\d:;]*m/;
// eslint-disable-next-line no-control-regex
const oscSequence = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/;

const hasControlCharacters = (text: string): boolean => {
	// eslint-disable-next-line no-control-regex
	return /[\u001B\u0080-\u009F]/.test(text);
};

const sanitizeAnsi = (text: string): string => {
	if (!hasControlCharacters(text)) {
		return text;
	}

	// eslint-disable-next-line no-control-regex
	const escapeMatcher = /\u001B[[\]P^_X][\s\S]*?(?:[\u0040-\u007E]|\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

	let output = "";
	let lastIndex = 0;

	for (
		let match = escapeMatcher.exec(text);
		match;
		match = escapeMatcher.exec(text)
	) {
		output += text.slice(lastIndex, match.index);

		const sequence = match[0];

		// Keep SGR (styling) and OSC (hyperlink) sequences; drop everything else.
		if (sgrSequence.test(sequence) || oscSequence.test(sequence)) {
			output += sequence;
		}

		lastIndex = escapeMatcher.lastIndex;
	}

	output += text.slice(lastIndex);

	return output;
};

// Squashing text nodes allows to combine multiple text nodes into one and write
// to `Output` instance only once. For example, <Text>hello{' '}world</Text>
// is actually 3 text nodes, which would result 3 writes to `Output`.
//
// Also, this is necessary for libraries like ink-link (https://github.com/sindresorhus/ink-link),
// which need to wrap all children at once, instead of wrapping 3 text nodes separately.
const squashTextNodes = (node: DOMElement): string => {
	let text = "";

	for (let index = 0; index < node.childNodes.length; index++) {
		const childNode = node.childNodes[index];

		if (childNode === undefined) {
			continue;
		}

		let nodeText = "";

		if (childNode.nodeName === "#text") {
			nodeText = childNode.nodeValue;
		} else {
			if (
				childNode.nodeName === "ink-text" ||
				childNode.nodeName === "ink-virtual-text"
			) {
				nodeText = squashTextNodes(childNode);
			}

			// Since these text nodes are being concatenated, `Output` instance won't be able to
			// apply children transform, so we have to do it manually here for each text node
			if (
				nodeText.length > 0 &&
				typeof childNode.internal_transform === "function"
			) {
				nodeText = childNode.internal_transform(nodeText, index);
			}
		}

		text += nodeText;
	}

	return sanitizeAnsi(text);
};

export default squashTextNodes;
