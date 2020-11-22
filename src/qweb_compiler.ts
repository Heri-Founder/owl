import { BDom, Blocks } from "./bdom";
import { compileExpr, compileExprToArray, interpolate, INTERP_REGEXP } from "./qweb_expressions";
import {
  AST,
  ASTComment,
  ASTComponent,
  ASTDebug,
  ASTDomNode,
  ASTLog,
  ASTMulti,
  ASTTCall,
  ASTTEsc,
  ASTText,
  ASTTForEach,
  ASTTif,
  ASTTKey,
  ASTTRaw,
  ASTTSet,
  ASTType,
  parse,
} from "./qweb_parser";
import { Dom, DomNode, domToString, DomType, UTILS } from "./qweb_utils";

// -----------------------------------------------------------------------------
// Compile functions
// -----------------------------------------------------------------------------

export type RenderFunction = (context: any) => BDom;
export type TemplateFunction = (blocks: typeof Blocks, utils: typeof UTILS) => RenderFunction;

export function compile(template: string, utils: typeof UTILS = UTILS): RenderFunction {
  const templateFunction = compileTemplate(template);
  return templateFunction(Blocks, utils);
}

export function compileTemplate(template: string): TemplateFunction {
  const ast = parse(template);
  // console.warn(ast);
  const compiler = new QWebCompiler();
  compiler.compile(ast);
  const code = compiler.generateCode();
  // console.warn(code);
  return new Function("Blocks, utils", code) as TemplateFunction;
}

export class TemplateSet {
  templates: { [name: string]: string } = {};
  compiledTemplates: { [name: string]: RenderFunction } = {};
  utils: typeof UTILS;

  constructor() {
    const call = (subTemplate: string, ctx: any) => {
      const renderFn = this.getFunction(subTemplate);
      return renderFn(ctx);
    };

    this.utils = Object.assign({}, UTILS, { call });
  }

  add(name: string, template: string) {
    this.templates[name] = template;
  }

  getFunction(name: string): RenderFunction {
    if (!(name in this.compiledTemplates)) {
      const template = this.templates[name];
      if (!template) {
        throw new Error(`Missing template: "${name}"`);
      }
      const templateFn = compileTemplate(template);
      const renderFn = templateFn(Blocks, this.utils);
      this.compiledTemplates[name] = renderFn;
    }
    return this.compiledTemplates[name];
  }
}

// -----------------------------------------------------------------------------
// BlockDescription
// -----------------------------------------------------------------------------

interface FunctionLine {
  path: string[];
  inserter(el: string): string;
}

class BlockDescription {
  varName: string;
  blockName: string;
  updateFn: FunctionLine[] = [];
  handlerFn: FunctionLine[] = [];
  currentPath: string[] = ["el"];
  dataNumber: number = 0;
  handlerNumber: number = 0;
  dom?: Dom;
  currentDom?: DomNode;
  childNumber: number = 0;

  constructor(varName: string, blockName: string) {
    this.varName = varName;
    this.blockName = blockName;
  }

  insert(dom: Dom) {
    if (this.currentDom) {
      this.currentDom.content.push(dom);
    } else {
      this.dom = dom;
    }
  }

  insertUpdate(inserter: (target: string) => string) {
    this.updateFn.push({ path: this.currentPath.slice(), inserter });
  }

  insertHandler(inserter: (target: string) => string) {
    this.handlerFn.push({ path: this.currentPath.slice(), inserter });
  }
}

// -----------------------------------------------------------------------------
// Compiler code
// -----------------------------------------------------------------------------
const FNAMEREGEXP = /^[$A-Z_][0-9A-Z_$]*$/i;

interface Context {
  block: BlockDescription | null;
  index: number | string;
  forceNewBlock: boolean;
}

interface MakeBlockParams {
  multi?: number;
  parentBlock?: string | null;
  parentIndex?: number | string | null;
}

class QWebCompiler {
  code: string[] = [];
  indentLevel: number = 0;
  blocks: BlockDescription[] = [];
  rootBlock: string | null = null;
  nextId = 1;
  shouldProtectScope: boolean = false;
  shouldDefineOwner: boolean = false;
  key: string | null = null;
  loopLevel: number = 0;
  isDebug: boolean = false;

  addLine(line: string) {
    const prefix = new Array(this.indentLevel + 2).join("  ");
    this.code.push(prefix + line);
  }

  generateId(prefix: string = ""): string {
    return `${prefix}${this.nextId++}`;
  }

  makeBlock({ multi, parentBlock, parentIndex }: MakeBlockParams = {}): BlockDescription {
    const name = multi ? "BMulti" : `Block${this.blocks.length + 1}`;
    const block = new BlockDescription(this.generateId("b"), name);
    if (!multi) {
      this.blocks.push(block);
    }
    if (!this.rootBlock) {
      this.rootBlock = block.varName;
    }
    const parentStr = parentBlock ? `${parentBlock}.children[${parentIndex}] = ` : "";
    this.addLine(`const ${block.varName} = ${parentStr}new ${name}(${multi || ""});`);
    return block;
  }

  generateCode(): string {
    let mainCode = this.code;
    this.code = [];
    this.indentLevel = 0;
    // define blocks and utility functions
    this.addLine(`let {BCollection, BComponent, BHtml, BMulti, BNode, BText} = Blocks;`);
    this.addLine(`let {elem, toString, withDefault, call, zero, scope, getValues, owner} = utils;`);
    this.addLine(``);

    // define all blocks
    for (let block of this.blocks) {
      this.generateBlockCode(block);
    }

    // micro optimization: remove trailing ctx = ctx.__proto__;
    if (mainCode[mainCode.length - 1] === `  ctx = ctx.__proto__;`) {
      mainCode = mainCode.slice(0, -1);
    }

    // generate main code
    this.indentLevel = 0;
    this.addLine(``);
    this.addLine(`return ctx => {`);
    if (this.shouldProtectScope || this.shouldDefineOwner) {
      this.addLine(`  ctx = Object.create(ctx);`);
    }
    if (this.shouldDefineOwner) {
      this.addLine(`  ctx[scope] = 1;`);
    }
    for (let line of mainCode) {
      this.addLine(line);
    }
    if (!this.rootBlock) {
      throw new Error("missing root block");
    }
    this.addLine(`  return ${this.rootBlock};`);
    this.addLine("}");
    const code = this.code.join("\n");

    if (this.isDebug) {
      const msg = `[Owl Debug]\n${code}`;
      console.log(msg);
    }
    return code;
  }

  generateBlockCode(block: BlockDescription) {
    this.addLine(`class ${block.blockName} extends BNode {`);
    this.indentLevel++;
    this.addLine(`static el = elem(\`${block.dom ? domToString(block.dom) : ""}\`);`);
    if (block.childNumber) {
      this.addLine(`children = new Array(${block.childNumber});`);
    }
    if (block.dataNumber) {
      this.addLine(`data = new Array(${block.dataNumber});`);
    }
    if (block.handlerNumber) {
      this.addLine(`handlers = new Array(${block.handlerNumber});`);
    }
    if (block.updateFn.length) {
      const updateInfo = block.updateFn;
      this.addLine(`update() {`);
      this.indentLevel++;
      if (updateInfo.length === 1) {
        const { path, inserter } = updateInfo[0];
        const target = `this.${path.join(".")}`;
        this.addLine(inserter(target));
      } else {
        this.generateFunctionCode(block.updateFn);
      }
      this.indentLevel--;
      this.addLine(`}`);
    }

    if (block.handlerFn.length) {
      const updateInfo = block.handlerFn;
      this.addLine(`build() {`);
      this.indentLevel++;
      this.addLine(`super.build();`);
      if (updateInfo.length === 1) {
        const { path, inserter } = updateInfo[0];
        const target = `this.${path.join(".")}`;
        this.addLine(inserter(target));
      } else {
        this.generateFunctionCode(block.handlerFn);
      }
      this.indentLevel--;
      this.addLine(`}`);
    }

    this.indentLevel--;
    this.addLine(`}`);
  }

  generateFunctionCode(lines: FunctionLine[]) {
    // build tree of paths
    const tree: any = {};
    let i = 1;
    for (let line of lines) {
      let current: any = tree;
      let el: string = `this`;
      for (let p of line.path.slice()) {
        if (current[p]) {
        } else {
          current[p] = { firstChild: null, nextSibling: null };
        }
        if (current.firstChild && current.nextSibling && !current.name) {
          current.name = `el${i++}`;
          this.addLine(`const ${current.name} = ${el};`);
        }
        el = `${current.name ? current.name : el}.${p}`;
        current = current[p];
        if (current.target && !current.name) {
          current.name = `el${i++}`;
          this.addLine(`const ${current.name} = ${el};`);
        }
      }
      current.target = true;
    }
    for (let line of lines) {
      const { path, inserter } = line;
      let current: any = tree;
      let el = `this`;
      for (let p of path.slice()) {
        current = current[p];
        if (current) {
          if (current.name) {
            el = current.name;
          } else {
            el = `${el}.${p}`;
          }
        } else {
          el = `${el}.${p}`;
        }
      }
      this.addLine(inserter(el));
    }
  }

  captureExpression(expr: string): string {
    const tokens = compileExprToArray(expr);
    const mapping = new Map<string, string>();
    return tokens
      .map((tok) => {
        if (tok.varName) {
          if (!mapping.has(tok.varName)) {
            const varId = this.generateId("v");
            mapping.set(tok.varName, varId);
            this.addLine(`const ${varId} = ${tok.value};`);
          }
          tok.value = mapping.get(tok.varName)!;
        }
        return tok.value;
      })
      .join("");
  }

  compile(ast: AST) {
    this.isDebug = ast.type === ASTType.TDebug;
    this.compileAST(ast, { block: null, index: 0, forceNewBlock: false });
  }

  compileAST(ast: AST, ctx: Context) {
    switch (ast.type) {
      case ASTType.Comment:
        this.compileComment(ast, ctx);
        break;
      case ASTType.Text:
        this.compileText(ast, ctx);
        break;
      case ASTType.DomNode:
        this.compileTDomNode(ast, ctx);
        break;
      case ASTType.TEsc:
        this.compileTEsc(ast, ctx);
        break;
      case ASTType.TRaw:
        this.compileTRaw(ast, ctx);
        break;
      case ASTType.TIf:
        this.compileTIf(ast, ctx);
        break;
      case ASTType.TForEach:
        this.compileTForeach(ast, ctx);
        break;
      case ASTType.TKey:
        this.compileTKey(ast, ctx);
        break;
      case ASTType.Multi:
        this.compileMulti(ast, ctx);
        break;
      case ASTType.TCall:
        this.compileTCall(ast, ctx);
        break;
      case ASTType.TSet:
        this.compileTSet(ast);
        break;
      case ASTType.TComponent:
        this.compileComponent(ast, ctx);
        break;
      case ASTType.TDebug:
        this.compileDebug(ast, ctx);
        break;
      case ASTType.TLog:
        this.compileLog(ast, ctx);
        break;
    }
  }

  compileDebug(ast: ASTDebug, ctx: Context) {
    this.addLine(`debugger;`);
    if (ast.content) {
      this.compileAST(ast.content, ctx);
    }
  }

  compileLog(ast: ASTLog, ctx: Context) {
    this.addLine(`console.log(${compileExpr(ast.expr)});`);
    if (ast.content) {
      this.compileAST(ast.content, ctx);
    }
  }
  compileComment(ast: ASTComment, ctx: Context) {
    let { block, index, forceNewBlock } = ctx;
    if (!block || forceNewBlock) {
      block = this.makeBlock({
        parentIndex: index,
        parentBlock: block ? block.varName : undefined,
      });
    }
    const text: Dom = { type: DomType.Comment, value: ast.value };
    block.insert(text);
  }

  compileText(ast: ASTText, ctx: Context) {
    let { block, index, forceNewBlock } = ctx;
    if (!block || forceNewBlock) {
      if (block) {
        this.addLine(`${block.varName}.children[${index}] = new BText(\`${ast.value}\`)`);
      } else {
        const id = this.generateId("b");
        this.addLine(`const ${id} = new BText(\`${ast.value}\`)`);
        if (!this.rootBlock) {
          this.rootBlock = id;
        }
      }
    } else {
      const type = ast.type === ASTType.Text ? DomType.Text : DomType.Comment;
      const text: Dom = { type, value: ast.value };
      block.insert(text);
    }
  }

  compileTDomNode(ast: ASTDomNode, ctx: Context) {
    let { block, index, forceNewBlock } = ctx;
    if (!block || forceNewBlock) {
      block = this.makeBlock({
        parentIndex: index,
        parentBlock: block ? block.varName : undefined,
      });
    }

    // attributes
    const staticAttrs: { [key: string]: string } = {};
    const dynAttrs: { [key: string]: string } = {};
    for (let key in ast.attrs) {
      if (key.startsWith("t-attf")) {
        dynAttrs[key.slice(7)] = interpolate(ast.attrs[key]);
      } else if (key.startsWith("t-att")) {
        dynAttrs[key.slice(6)] = compileExpr(ast.attrs[key]);
      } else {
        staticAttrs[key] = ast.attrs[key];
      }
    }
    if (Object.keys(dynAttrs).length) {
      for (let key in dynAttrs) {
        const idx = block.dataNumber;
        block.dataNumber++;
        this.addLine(`${block.varName}.data[${idx}] = ${dynAttrs[key]};`);
        if (key === "class") {
          block.insertUpdate((el) => `this.updateClass(${el}, this.data[${idx}]);`);
        } else {
          block.insertUpdate((el) => `this.updateAttr(${el}, \`${key}\`, this.data[${idx}]);`);
        }
      }
    }

    // event handlers
    for (let event in ast.on) {
      this.shouldDefineOwner = true;
      const index = block.handlerNumber;
      block.handlerNumber++;
      block.insertHandler((el) => `this.setupHandler(${el}, ${index});`);
      const value = ast.on[event];
      let args: string = "";
      let code: string = "";
      const name: string = value.replace(/\(.*\)/, function (_args) {
        args = _args.slice(1, -1);
        return "";
      });
      const isMethodCall = name.match(FNAMEREGEXP);
      if (isMethodCall) {
        if (args) {
          const argId = this.generateId("arg");
          this.addLine(`const ${argId} = [${compileExpr(args)}];`);
          code = `owner(ctx)['${name}'](...${argId}, e)`;
        } else {
          code = `owner(ctx)['${name}'](e)`;
        }
      } else {
        code = this.captureExpression(value);
      }
      this.addLine(`${block.varName}.handlers[${index}] = [\`${event}\`, (e) => ${code}];`);
    }

    const dom: Dom = { type: DomType.Node, tag: ast.tag, attrs: staticAttrs, content: [] };
    block.insert(dom);
    if (ast.content.length) {
      const initialDom = block.currentDom;
      block.currentDom = dom;
      const path = block.currentPath.slice();
      block.currentPath.push("firstChild");
      for (let child of ast.content) {
        const subCtx: Context = {
          block: block,
          index: block.childNumber,
          forceNewBlock: false,
        };
        this.compileAST(child, subCtx);
        if (child.type !== ASTType.TSet) {
          block.currentPath.push("nextSibling");
        }
      }
      block.currentPath = path;
      block.currentDom = initialDom;
    }
  }

  compileTEsc(ast: ASTTEsc, ctx: Context) {
    let { block, index, forceNewBlock } = ctx;
    let expr: string;
    if (ast.expr === "0") {
      expr = `ctx[zero]`;
    } else {
      expr = compileExpr(ast.expr);
      if (ast.defaultValue) {
        expr = `withDefault(${expr}, \`${ast.defaultValue}\`)`;
      }
    }
    if (!block || forceNewBlock) {
      if (block) {
        this.addLine(`${block.varName}.children[${index}] = new BText(${expr})`);
      } else {
        const id = this.generateId("b");
        this.addLine(`const ${id} = new BText(${expr})`);
        if (!this.rootBlock) {
          this.rootBlock = id;
        }
      }
    } else {
      const text: Dom = { type: DomType.Node, tag: "owl-text", attrs: {}, content: [] };
      block.insert(text);
      const idx = block.dataNumber;
      block.dataNumber++;
      this.addLine(`${block.varName}.data[${idx}] = ${expr};`);
      if (ast.expr === "0") {
        block.insertUpdate((el) => `${el}.textContent = this.data[${idx}];`);
      } else {
        block.insertUpdate((el) => `${el}.textContent = toString(this.data[${idx}]);`);
      }
    }
  }

  compileTRaw(ast: ASTTRaw, ctx: Context) {
    let { block, index } = ctx;
    if (!block) {
      block = this.makeBlock({ multi: 1, parentBlock: null, parentIndex: index });
    }
    const anchor: Dom = { type: DomType.Node, tag: "owl-anchor", attrs: {}, content: [] };
    block.insert(anchor);
    block.currentPath = [`anchors[${block.childNumber}]`];
    block.childNumber++;
    let expr = ast.expr === "0" ? "ctx[zero]" : compileExpr(ast.expr);
    if (ast.body) {
      const nextId = this.nextId;
      const subCtx: Context = { block: null, index: 0, forceNewBlock: true };
      this.compileAST({ type: ASTType.Multi, content: ast.body }, subCtx);
      expr = `withDefault(${expr}, b${nextId})`;
    }
    this.addLine(`${block.varName}.children[${index}] = new BHtml(${expr});`);
  }

  compileTIf(ast: ASTTif, ctx: Context) {
    let { block, index } = ctx;
    if (!block) {
      const n = 1 + (ast.tElif ? ast.tElif.length : 0) + (ast.tElse ? 1 : 0);
      block = this.makeBlock({ multi: n, parentBlock: null, parentIndex: index });
    }
    this.addLine(`if (${compileExpr(ast.condition)}) {`);
    this.indentLevel++;
    const anchor: Dom = { type: DomType.Node, tag: "owl-anchor", attrs: {}, content: [] };
    block.insert(anchor);
    block.currentPath = [`anchors[${block.childNumber}]`];
    block.childNumber++;
    const subCtx: Context = { block: block, index: index, forceNewBlock: true };

    this.compileAST(ast.content, subCtx);
    this.indentLevel--;
    if (ast.tElif) {
      for (let clause of ast.tElif) {
        this.addLine(`} else if (${compileExpr(clause.condition)}) {`);
        this.indentLevel++;
        const anchor: Dom = { type: DomType.Node, tag: "owl-anchor", attrs: {}, content: [] };
        block.insert(anchor);
        block.childNumber++;
        const subCtx: Context = {
          block: block,
          index: block.childNumber - 1,
          forceNewBlock: true,
        };
        this.compileAST(clause.content, subCtx);
        this.indentLevel--;
      }
    }
    if (ast.tElse) {
      this.addLine(`} else {`);
      this.indentLevel++;
      const anchor: Dom = { type: DomType.Node, tag: "owl-anchor", attrs: {}, content: [] };
      block.insert(anchor);
      block.childNumber++;
      const subCtx: Context = {
        block: block,
        index: block.childNumber - 1,
        forceNewBlock: true,
      };
      this.compileAST(ast.tElse, subCtx);

      this.indentLevel--;
    }
    this.addLine("}");
  }

  compileTForeach(ast: ASTTForEach, ctx: Context) {
    const { block, index } = ctx;
    const cId = this.generateId();
    const vals = `v${cId}`;
    const keys = `k${cId}`;
    const l = `l${cId}`;
    this.addLine(`const [${vals}, ${keys}, ${l}] = getValues(${compileExpr(ast.collection)});`);

    const id = this.generateId("b");

    if (block) {
      const anchor: Dom = { type: DomType.Node, tag: "owl-anchor", attrs: {}, content: [] };
      block.insert(anchor);
      block.currentPath = [`anchors[${block.childNumber}]`];
      block.childNumber++;

      this.addLine(`const ${id} = ${block.varName}.children[${index}] = new BCollection(${l});`);
    } else {
      this.addLine(`const ${id} = new BCollection(${l});`);
      if (!this.rootBlock) {
        this.rootBlock = id;
      }
    }
    this.loopLevel++;
    const loopVar = `i${this.loopLevel}`;
    this.addLine(`ctx = Object.create(ctx);`);
    this.addLine(`for (let ${loopVar} = 0; ${loopVar} < ${l}; ${loopVar}++) {`);
    this.indentLevel++;
    this.addLine(`ctx[\`${ast.elem}\`] = ${vals}[${loopVar}];`);
    this.addLine(`ctx[\`${ast.elem}_first\`] = ${loopVar} === 0;`);
    this.addLine(`ctx[\`${ast.elem}_last\`] = ${loopVar} === ${vals}.length - 1;`);
    this.addLine(`ctx[\`${ast.elem}_index\`] = ${loopVar};`);
    this.addLine(`ctx[\`${ast.elem}_value\`] = ${keys}[${loopVar}];`);

    const collectionBlock = new BlockDescription(id, "Collection");
    const subCtx: Context = {
      block: collectionBlock,
      index: loopVar,
      forceNewBlock: true,
    };
    this.compileAST(ast.body, subCtx);
    this.indentLevel--;
    this.addLine(`}`);
    this.loopLevel--;
    this.addLine(`ctx = ctx.__proto__;`);
  }

  compileTKey(ast: ASTTKey, ctx: Context) {
    const id = this.generateId("k");
    this.addLine(`const ${id} = ${compileExpr(ast.expr)};`);
    const currentKey = this.key;
    this.key = id;
    this.compileAST(ast.content, ctx);
    this.key = currentKey;
  }

  compileMulti(ast: ASTMulti, ctx: Context) {
    let { block, index: currentIndex, forceNewBlock } = ctx;
    if (!block || forceNewBlock) {
      const n = ast.content.filter((c) => c.type !== ASTType.TSet).length;
      if (n === 1) {
        for (let child of ast.content) {
          this.compileAST(child, ctx);
        }
        return;
      }
      block = this.makeBlock({
        multi: n,
        parentBlock: block ? block.varName : undefined,
        parentIndex: currentIndex,
      });
    }

    let index = 0;
    for (let i = 0; i < ast.content.length; i++) {
      const child = ast.content[i];
      const isTSet = child.type === ASTType.TSet;
      const subCtx: Context = { block: block, index: index, forceNewBlock: !isTSet };
      this.compileAST(child, subCtx);
      if (!isTSet) {
        index++;
      }
    }
  }

  compileTCall(ast: ASTTCall, ctx: Context) {
    const { block, index, forceNewBlock } = ctx;
    this.shouldDefineOwner = true;
    if (ast.body) {
      this.addLine(`ctx = Object.create(ctx);`);
      // check if all content is t-set
      const hasContent = ast.body.filter((elem) => elem.type !== ASTType.TSet).length;
      if (hasContent) {
        const nextId = this.nextId;
        const subCtx: Context = { block: null, index: 0, forceNewBlock: true };
        this.compileAST({ type: ASTType.Multi, content: ast.body }, subCtx);
        this.addLine(`ctx[zero] = b${nextId};`);
      } else {
        for (let elem of ast.body) {
          const subCtx: Context = { block: block, index: 0, forceNewBlock: false };
          this.compileAST(elem, subCtx);
        }
      }
    }

    const isDynamic = INTERP_REGEXP.test(ast.name);
    const subTemplate = isDynamic ? interpolate(ast.name) : "`" + ast.name + "`";

    if (block) {
      if (!forceNewBlock) {
        const anchor: Dom = { type: DomType.Node, tag: "owl-anchor", attrs: {}, content: [] };
        block.insert(anchor);
        block.currentPath = [`anchors[${block.childNumber}]`];
        block.childNumber++;
      }

      this.addLine(`${block.varName}.children[${index}] = call(${subTemplate}, ctx);`);
    } else {
      const id = this.generateId("b");
      this.rootBlock = id;
      this.addLine(`const ${id} = call(${subTemplate}, ctx);`);
    }
    if (ast.body) {
      this.addLine(`ctx = ctx.__proto__;`);
    }
  }

  compileTSet(ast: ASTTSet) {
    this.shouldProtectScope = true;
    const expr = ast.value ? compileExpr(ast.value || "") : "null";
    if (ast.body) {
      const nextId = this.nextId;
      const subCtx: Context = { block: null, index: 0, forceNewBlock: true };
      this.compileAST({ type: ASTType.Multi, content: ast.body }, subCtx);
      const value = ast.value ? `withDefault(${expr}, b${nextId})` : `b${nextId}`;
      this.addLine(`ctx[\`${ast.name}\`] = ${value};`);
    } else {
      let value: string;
      if (ast.defaultValue) {
        if (ast.value) {
          value = `withDefault(${expr}, \`${ast.defaultValue}\`)`;
        } else {
          value = `\`${ast.defaultValue}\``;
        }
      } else {
        value = expr;
      }
      this.addLine(`ctx[\`${ast.name}\`] = ${value};`);
    }
  }

  compileComponent(ast: ASTComponent, ctx: Context) {
    const { block, index } = ctx;
    // props
    const props: string[] = [];
    for (let p in ast.props) {
      props.push(`${p}: ${compileExpr(ast.props[p])}`);
    }
    const propString = `{${props.join(",")}}`;
    const blockString = `new BComponent(ctx, \`${ast.name}\`, ${propString})`;

    if (block) {
      const anchor: Dom = { type: DomType.Node, tag: "owl-anchor", attrs: {}, content: [] };
      block.insert(anchor);
      block.currentPath = [`anchors[${block.childNumber}]`];
      block.childNumber++;

      this.addLine(`${block.varName}.children[${index}] = ${blockString}`);
    } else {
      const id = this.generateId("b");
      if (!this.rootBlock) {
        this.rootBlock = id;
      }
      this.addLine(`const ${id} = ${blockString}`);
    }
  }
}