// 简易 TS 运行钩子：转译 .ts 并把 '@/...' 别名解析到 src/。
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const srcRoot = path.join(__dirname, '..', 'src')

require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  })
  module._compile(out.outputText, filename)
}

const originalResolve = require('module')._resolveFilename
require('module')._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    request = path.join(srcRoot, request.slice(2))
  }
  return originalResolve.call(this, request, ...rest)
}
