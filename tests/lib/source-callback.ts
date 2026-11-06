import { readFileSync } from "node:fs"
import ts from "typescript"

export function sourceCallback<T>(file: string, name: string, scope: Record<string, unknown>): T {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback) throw new Error(`No callback named ${name} in ${file}`)
  const code = ts.transpileModule(`return (${callback.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
  return new Function(...Object.keys(scope), code)(...Object.values(scope)) as T
}
