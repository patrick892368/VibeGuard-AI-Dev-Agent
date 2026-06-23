function stripInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === "#" && quote === null) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function parseScalar(rawValue) {
  const value = stripInlineComment(rawValue.trim());
  if (value === "") return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function splitKeyValue(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ((char === '"' || char === "'") && text[index - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === ":" && quote === null) {
      return [text.slice(0, index).trim(), text.slice(index + 1)];
    }
  }
  return null;
}

function toEntries(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const withoutComment = stripInlineComment(line);
      return {
        indent: withoutComment.match(/^\s*/)[0].length,
        text: withoutComment.trim()
      };
    })
    .filter((entry) => entry.text.length > 0);
}

export function parseYamlSubset(text) {
  const entries = toEntries(text);
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    while (stack.length > 1 && stack[stack.length - 1].indent >= entry.indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;

    if (entry.text.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`Invalid YAML subset: list item without list parent near "${entry.text}"`);
      }
      const rawItem = entry.text.slice(2).trim();
      const inlineObject = splitKeyValue(rawItem);
      if (inlineObject && inlineObject[1].trim() !== "") {
        parent.push({ [inlineObject[0]]: parseScalar(inlineObject[1]) });
      } else {
        parent.push(parseScalar(rawItem));
      }
      continue;
    }

    const pair = splitKeyValue(entry.text);
    if (!pair) {
      throw new Error(`Invalid YAML subset: expected key/value near "${entry.text}"`);
    }

    const [key, rawValue] = pair;
    if (!key) {
      throw new Error(`Invalid YAML subset: empty key near "${entry.text}"`);
    }

    if (rawValue.trim() !== "") {
      parent[key] = parseScalar(rawValue);
      continue;
    }

    const next = entries[index + 1];
    const child = next && next.indent > entry.indent && next.text.startsWith("- ") ? [] : {};
    parent[key] = child;
    stack.push({ indent: entry.indent, value: child });
  }

  return root;
}
