// I cant' get this import to work locally. The import in node_modules is
// javy/dist but esbuild requires the import to be javy/fs
//
// @ts-expect-error
import { readFileSync, writeFileSync, STDIO } from "javy/fs";
import {
  EmitHint,
  FunctionDeclaration,
  NewLineKind,
  TypeNode,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  Node,
  NodeFlags,
  createPrinter,
  createSourceFile,
  factory,
} from "typescript";

import {
  GenerateRequest,
  GenerateResponse,
  Parameter,
  Column,
  File,
} from "./gen/plugin/codegen_pb";

import { argName, colName } from "./drivers/utlis";
import pg from "./drivers/pg";
import postgres from "./drivers/postgres";
import mysql2 from "./drivers/mysql2";

// Read input from stdin
const input = readInput();
// Call the function with the input
const result = codegen(input);
// Write the result to stdout
writeOutput(result);

interface Options {
  runtime?: string;
  driver?: string;
}

interface Driver {
  preamble: () => Node[];
  columnType: (c?: Column) => TypeNode;
  execDecl: (
    name: string,
    text: string,
    iface: string | undefined,
    params: Parameter[]
  ) => Node;
  manyDecl: (
    name: string,
    text: string,
    argIface: string | undefined,
    returnIface: string,
    params: Parameter[],
    columns: Column[]
  ) => Node;
  oneDecl: (
    name: string,
    text: string,
    argIface: string | undefined,
    returnIface: string,
    params: Parameter[],
    columns: Column[]
  ) => Node;
}

function createNodeGenerator(driver?: string): Driver {
  switch (driver) {
    case "mysql2": {
      return mysql2;
    }
    case "pg": {
      return pg;
    }
    case "postgres": {
      return postgres;
    }
  }
  throw new Error(`unknown driver: ${driver}`);
}

function codegen(input: GenerateRequest): GenerateResponse {
  let files = [];
  let options: Options = {};

  if (input.pluginOptions.length > 0) {
    const text = new TextDecoder().decode(input.pluginOptions);
    options = JSON.parse(text) as Options;
  }

  const driver = createNodeGenerator(options.driver);

  // TODO: Verify options, parse them from protobuf honestly

  const querymap = new Map<string, Node[]>();

  const filenames = new Set(input.queries.map((q) => q.filename));
  for (const filename of filenames) {
    const nodes = driver.preamble();
    querymap.set(filename, nodes);
  }

  for (const query of input.queries) {
    let nodes = querymap.get(query.filename);
    if (!nodes) {
      continue;
    }

    const colmap = new Map<string, number>();
    for (let column of query.columns) {
      if (!column.name) {
        continue;
      }
      const count = colmap.get(column.name) || 0;
      if (count > 0) {
        column.name = `${column.name}_${count + 1}`;
      }
      colmap.set(column.name, count + 1);
    }

    const lowerName = query.name[0].toLowerCase() + query.name.slice(1);
    const textName = `${lowerName}Query`;

    nodes.push(
      queryDecl(
        textName,
        `-- name: ${query.name} ${query.cmd}
${query.text}`
      )
    );

    const ctype = driver.columnType;

    let argIface = undefined;
    let returnIface = undefined;
    if (query.params.length > 0) {
      argIface = `${query.name}Args`;
      nodes.push(argsDecl(argIface, ctype, query.params));
    }
    if (query.columns.length > 0) {
      returnIface = `${query.name}Row`;
      nodes.push(rowDecl(returnIface, ctype, query.columns));
    }

    switch (query.cmd) {
      case ":exec": {
        nodes.push(
          driver.execDecl(lowerName, textName, argIface, query.params)
        );
        break;
      }
      case ":one": {
        nodes.push(
          driver.oneDecl(
            lowerName,
            textName,
            argIface,
            returnIface ?? "void",
            query.params,
            query.columns
          )
        );
        break;
      }
      case ":many": {
        nodes.push(
          driver.manyDecl(
            lowerName,
            textName,
            argIface,
            returnIface ?? "void",
            query.params,
            query.columns
          )
        );
        break;
      }
    }
  }

  for (const filename of filenames) {
    const nodes = querymap.get(filename);
    if (nodes) {
      files.push(
        new File({
          name: `${filename.replace(".", "_")}.ts`,
          contents: new TextEncoder().encode(printNode(nodes)),
        })
      );
    }
  }

  return new GenerateResponse({
    files: files,
  });
}

// Read input from stdin
function readInput(): GenerateRequest {
  const buffer = readFileSync(STDIO.Stdin);
  return GenerateRequest.fromBinary(buffer);
}

function queryDecl(name: string, sql: string) {
  return factory.createVariableStatement(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createIdentifier(name),
          undefined,
          undefined,
          factory.createNoSubstitutionTemplateLiteral(sql, sql)
        ),
      ],
      NodeFlags.Const //| NodeFlags.Constant | NodeFlags.Constant
    )
  );
}

function argsDecl(
  name: string,
  ctype: (c?: Column) => TypeNode,
  params: Parameter[]
) {
  return factory.createInterfaceDeclaration(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    factory.createIdentifier(name),
    undefined,
    undefined,
    params.map((param, i) =>
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(argName(i, param.column)),
        undefined,
        ctype(param.column)
      )
    )
  );
}

function rowDecl(
  name: string,
  ctype: (c?: Column) => TypeNode,
  columns: Column[]
) {
  return factory.createInterfaceDeclaration(
    [factory.createToken(SyntaxKind.ExportKeyword)],
    factory.createIdentifier(name),
    undefined,
    undefined,
    columns.map((column, i) =>
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(colName(i, column)),
        undefined,
        ctype(column)
      )
    )
  );
}

function printNode(nodes: Node[]): string {
  // https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API#creating-and-printing-a-typescript-ast
  const resultFile = createSourceFile(
    "file.ts",
    "",
    ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ScriptKind.TS
  );
  const printer = createPrinter({ newLine: NewLineKind.LineFeed });
  let output = "";
  for (let node of nodes) {
    output += printer.printNode(EmitHint.Unspecified, node, resultFile);
    output += "\n\n";
  }
  return output;
}

// Write output to stdout
function writeOutput(output: GenerateResponse) {
  const encodedOutput = output.toBinary();
  const buffer = new Uint8Array(encodedOutput);
  writeFileSync(STDIO.Stdout, buffer);
}
