import { monaco } from "@/components/code/monaco"
import "monaco-editor/languages/definitions/systemverilog/register"

const KEYWORDS = [
  "abs", "access", "after", "alias", "all", "and", "architecture", "array", "assert", "attribute", "begin", "block", "body", "buffer", "bus",
  "case", "component", "configuration", "constant", "context", "disconnect", "downto", "else", "elsif", "end", "entity", "exit", "file", "for",
  "force", "function", "generate", "generic", "group", "guarded", "if", "impure", "in", "inertial", "inout", "is", "label", "library", "linkage",
  "literal", "loop", "map", "mod", "nand", "new", "next", "nor", "not", "null", "of", "on", "open", "or", "others", "out", "package", "port",
  "postponed", "procedure", "process", "protected", "pure", "range", "record", "register", "reject", "release", "rem", "report", "return",
  "rol", "ror", "select", "severity", "signal", "shared", "sla", "sll", "sra", "srl", "subtype", "then", "to", "transport", "type",
  "unaffected", "units", "until", "use", "variable", "wait", "when", "while", "with", "xnor", "xor",
]

const TYPES = [
  "std_logic", "std_ulogic", "std_logic_vector", "std_ulogic_vector", "unsigned", "signed", "integer", "natural", "positive", "boolean",
  "bit", "bit_vector", "real", "time", "string", "character",
]

let registered = false

export function registerHdlLanguages() {
  if (registered) return
  registered = true
  monaco.languages.register({ id: "vhdl", extensions: [".vhd", ".vhdl"], aliases: ["VHDL", "vhdl"] })
  monaco.languages.setLanguageConfiguration("vhdl", {
    comments: { lineComment: "--", blockComment: ["/*", "*/"] },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
    indentationRules: {
      increaseIndentPattern: /^\s*(begin|then|else|elsif\b.*|loop|is|process\b.*|generate|record|port\s*\(|generic\s*\()\s*(--.*)?$/i,
      decreaseIndentPattern: /^\s*(end\b.*|else|elsif\b.*|begin|\);?)\s*$/i,
    },
  })
  monaco.languages.setMonarchTokensProvider("vhdl", {
    ignoreCase: true,
    keywords: KEYWORDS,
    typeKeywords: TYPES,
    tokenizer: {
      root: [
        [/--.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/[xXoObB]?"[0-9a-fA-F_uUxXzZwWlLhH-]*"/, "number"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'[01uUxXzZwWlLhH-]'/, "number"],
        [/\d+(\.\d+)?([eE][-+]?\d+)?(\s*(fs|ps|ns|us|ms|sec|min|hr))?\b/, "number"],
        [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" } }],
        [/'[a-zA-Z_]\w*/, "attribute.name"],
        [/<=|=>|:=|\/=|>=|\*\*|[-+*/&=<>|]/, "operator"],
        [/[();,.:]/, "delimiter"],
      ],
      comment: [
        [/\*\//, "comment", "@pop"],
        [/./, "comment"],
      ],
    },
  })
}

export function languageId(path: string): string {
  if (/\.(vhd|vhdl)$/i.test(path)) return "vhdl"
  if (/\.sv$/i.test(path)) return "systemverilog"
  if (/\.v$/i.test(path)) return "verilog"
  return "plaintext"
}
