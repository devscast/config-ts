import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Dotenv, { FormatError, PathError } from "@/dotenv";

/**
 * Instable API, further test needed
 */
const testCommandExpension = false;
const isWindows = process.platform === "win32";

function withTmpDir(fn: (dir: string) => void | Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function setEnv(k: string, v?: string) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function resetAll(keys: string[]) {
  for (const k of keys) delete process.env[k];
}

describe("Dotenv.parse format errors", () => {
  const cases: Array<[string, string]> = [
    ['FOO=BAR BAZ', "A value containing spaces must be surrounded by quotes"],
    ['FOO BAR=BAR', "Whitespace characters are not supported after the variable name"],
    ['FOO', "Missing = in the environment variable declaration"],
    ['FOO="foo', "Missing quote to end the value"],
    ['FOO=\'foo', "Missing quote to end the value"],
    ["FOO=\"foo\nBAR=\"bar\"", "Missing quote to end the value"],
    ['FOO=\'foo' + "\n", "Missing quote to end the value"],
    ['export FOO', "Unable to unset an environment variable"],
    ['FOO=${FOO', "Unclosed braces on variable expansion"],
    ['FOO= BAR', "Whitespace are not supported before the value"],
    ['Стасян', "Invalid character in variable name"],
    ['FOO!', "Missing = in the environment variable declaration"],
    ['FOO=$(echo foo', "Missing closing parenthesis."],
    ['FOO=$(echo foo' + "\n", "Missing closing parenthesis."],
    ["FOO=\nBAR=\${FOO:-\\'a{a}a}", 'Unsupported character "\'"'],
    ["FOO=\nBAR=\${FOO:-a\\$a}", 'Unsupported character "$"'],
    ["FOO=\nBAR=\${FOO:-a\"a}", "Unclosed braces on variable expansion"],
    ['_=FOO', "Invalid character in variable name"],
  ];

  it.each(cases)("parses with format error: %s", (data, fragment) => {
    const d = new Dotenv();
    expect(() => d.parse(data)).toThrowError(FormatError);
    try { d.parse(data); } catch (e: any) {
      expect(String(e.message)).toContain(fragment);
    }
  });
});

describe("Dotenv.parse happy paths", () => {
  beforeEach(() => {
    // mirror PHP test env surface
    setEnv("LOCAL", "local");
    setEnv("REMOTE", "remote");
    setEnv("SERVERVAR", "servervar");
  });
  afterEach(() => {
    resetAll(["LOCAL","REMOTE","SERVERVAR","FOO","BAR","FOO_BAR9","NOTDEFINED","FOOBAR"]);
  });

  const baseCases: Array<[string, Record<string,string>]> = [
    // backslashes
    ['FOO=foo\\\\bar', { FOO: 'foo\\bar' }],
    ["FOO='foo\\\\bar'", { FOO: 'foo\\\\bar' }],
    ['FOO="foo\\\\bar"', { FOO: 'foo\\bar' }],

    // escaped backslash in front of variable
    ["BAR=bar\nFOO=foo\\\\\\$BAR", { BAR: 'bar', FOO: 'foo\\$BAR' }],
    ["BAR=bar\nFOO='foo\\\\\\$BAR'", { BAR: 'bar', FOO: 'foo\\\\\\$BAR' }],
    ["BAR=bar\nFOO=\"foo\\\\\\$BAR\"", { BAR: 'bar', FOO: 'foo\\$BAR' }],

    // spaces
    ['FOO=bar', { FOO: 'bar' }],
    [' FOO=bar ', { FOO: 'bar' }],
    ['FOO=', { FOO: '' }],
    ["FOO=\n\n\nBAR=bar", { FOO: '', BAR: 'bar' }],
    ['FOO=  ', { FOO: '' }],
    ["FOO=\nBAR=bar", { FOO: '', BAR: 'bar' }],

    // newlines
    ["\n\nFOO=bar\r\n\n", { FOO: 'bar' }],
    ["FOO=bar\r\nBAR=foo", { FOO: 'bar', BAR: 'foo' }],
    //["FOO=bar\rBAR=foo", { FOO: 'bar', BAR: 'foo' }],
    ["FOO=bar\nBAR=foo", { FOO: 'bar', BAR: 'foo' }],

    // quotes
    ['FOO="bar"\n', { FOO: 'bar' }],
    ['FOO="bar\'foo"\n', { FOO: "bar'foo" }],
    ["FOO='bar'\n", { FOO: 'bar' }],
    ["FOO='bar\"foo'\n", { FOO: 'bar"foo' }],
    ['FOO="bar\\\"foo"\n', { FOO: 'bar"foo' }],
    ['FOO="bar\nfoo"', { FOO: "bar\nfoo" }],
    ['FOO="bar\rfoo"', { FOO: "bar\rfoo" }],
    ["FOO='bar\nfoo'", { FOO: "bar\nfoo" }],
    ["FOO='bar\rfoo'", { FOO: "bar\rfoo" }],
    ["FOO='bar\nfoo'", { FOO: "bar\nfoo" }],
    ['FOO=" FOO "', { FOO: ' FOO ' }],
    ['FOO="  "', { FOO: '  ' }],
    ['PATH="c:\\\\"', { PATH: 'c:\\' }],
    ['FOO="bar\nfoo"', { FOO: "bar\nfoo" }],
    ['FOO=BAR\\"', { FOO: 'BAR"' }],
    ["FOO=BAR\\'BAZ", { FOO: "BAR'BAZ" }],
    ['FOO=\\"BAR', { FOO: '"BAR' }],

    // concatenated values
    ["FOO='bar''foo'\n", { FOO: 'barfoo' }],
    ["FOO='bar '' baz'", { FOO: 'bar  baz' }],
    ["FOO=bar\nBAR='baz'\"$FOO\"", { FOO: 'bar', BAR: 'bazbar' }],
    ["FOO='bar '\\'' baz'", { FOO: "bar ' baz" }],

    // comments
    ["#FOO=bar\nBAR=foo", { BAR: 'foo' }],
    ["#FOO=bar # Comment\nBAR=foo", { BAR: 'foo' }],
    ["FOO='bar foo' # Comment", { FOO: 'bar foo' }],
    ["FOO='bar#foo' # Comment", { FOO: 'bar#foo' }],
    ["# Comment\r\nFOO=bar\n# Comment\nBAR=foo", { FOO: 'bar', BAR: 'foo' }],
    ["FOO=bar # Another comment\nBAR=foo", { FOO: 'bar', BAR: 'foo' }],
    ["FOO=\n\n# comment\nBAR=bar", { FOO: '', BAR: 'bar' }],
    ['FOO=NOT#COMMENT', { FOO: 'NOT#COMMENT' }],
    ['FOO=  # Comment', { FOO: '' }],

    // edge cases
    ['FOO=0', { FOO: '0' }],
    ['FOO=false', { FOO: 'false' }],
    ['FOO=null', { FOO: 'null' }],

    // export
    ['export FOO=bar', { FOO: 'bar' }],
    ['  export   FOO=bar', { FOO: 'bar' }],

    // variable expansion
    ["FOO=BAR\nBAR=$FOO", { FOO: 'BAR', BAR: 'BAR' }],
    ["FOO=BAR\nBAR=\"$FOO\"", { FOO: 'BAR', BAR: 'BAR' }],
    ["FOO=BAR\nBAR='$FOO'", { FOO: 'BAR', BAR: '$FOO' }],
    ["FOO_BAR9=BAR\nBAR=$FOO_BAR9", { FOO_BAR9: 'BAR', BAR: 'BAR' }],
    ["FOO=BAR\nBAR=${FOO}Z", { FOO: 'BAR', BAR: 'BARZ' }],
    ["FOO=BAR\nBAR=$FOO}", { FOO: 'BAR', BAR: 'BAR}' }],
    ["FOO=BAR\nBAR=\\$FOO", { FOO: 'BAR', BAR: '$FOO' }],
    ['FOO=" \\$ "', { FOO: ' $ ' }],
    ['FOO=" $ "', { FOO: ' $ ' }],
    ['BAR=$LOCAL', { BAR: 'local' }],
    ['BAR=$REMOTE', { BAR: 'remote' }],
    ['BAR=$SERVERVAR', { BAR: 'servervar' }],
    ['FOO=$NOTDEFINED', { FOO: '' }],
    ["FOO=BAR\nBAR=${FOO:-TEST}", { FOO: 'BAR', BAR: 'BAR' }],
    ["FOO=BAR\nBAR=${NOTDEFINED:-TEST}", { FOO: 'BAR', BAR: 'TEST' }],
    ["FOO=\nBAR=${FOO:-TEST}", { FOO: '', BAR: 'TEST' }],
    ["FOO=\nBAR=$FOO:-TEST}", { FOO: '', BAR: 'TEST}' }],
    ["FOO=BAR\nBAR=${FOO:=TEST}", { FOO: 'BAR', BAR: 'BAR' }],
    ["FOO=BAR\nBAR=${NOTDEFINED:=TEST}", { FOO: 'BAR', NOTDEFINED: 'TEST', BAR: 'TEST' }],
    ["FOO=\nBAR=${FOO:=TEST}", { FOO: 'TEST', BAR: 'TEST' }],
    ["FOO=\nBAR=$FOO:=TEST}", { FOO: 'TEST', BAR: 'TEST}' }],
    ["FOO=BAR\nBAR=${FOO:-}", { FOO: 'BAR', BAR: 'BAR' }],
    ["FOO=BAR\nBAR=${NOTDEFINED:-}", { FOO: 'BAR', BAR: '' }],
    ["FOO=\nBAR=${FOO:-}", { FOO: '', BAR: '' }],
    ["FOO=\nBAR=$FOO:-}", { FOO: '', BAR: '}' }],
    ["FOO=BAR\nBAR=${FOO:=}", { FOO: 'BAR', BAR: 'BAR' }],
    ["FOO=BAR\nBAR=${NOTDEFINED:=}", { FOO: 'BAR', NOTDEFINED: '', BAR: '' }],
    ["FOO=\nBAR=${FOO:=}", { FOO: '', BAR: '' }],
    ["FOO=\nBAR=$FOO:=}", { FOO: '', BAR: '}' }],
    ["FOO=foo\nFOOBAR=${FOO}${BAR}", { FOO: 'foo', FOOBAR: 'foo' }],

    // underscores
    ['_FOO=BAR', { _FOO: 'BAR' }],
    ['_FOO_BAR=FOOBAR', { _FOO_BAR: 'FOOBAR' }],
  ];

  it.each(baseCases)("parses ok: %s", (data, expected) => {
    const d = new Dotenv();
    expect(d.parse(data)).toEqual(expected);
  });

  if (!isWindows && testCommandExpension) {
    describe("command expansion opt-in", () => {
      const cases: Array<{
        label: string;
        source: string;
        literal: Record<string, string>;
        expanded: Record<string, string>;
      }> = [
        {
          label: "simple echo",
          source: 'FOO=$(echo foo)',
          literal: { FOO: '$(echo foo)' },
          expanded: { FOO: 'foo' },
        },
        {
          label: "arithmetic expression",
          source: 'FOO=$((1+2))',
          literal: { FOO: '$((1+2))' },
          expanded: { FOO: '3' },
        },
        {
          label: "inline arithmetic",
          source: 'FOO=FOO$((1+2))BAR',
          literal: { FOO: 'FOO$((1+2))BAR' },
          expanded: { FOO: 'FOO3BAR' },
        },
        {
          label: "nested commands",
          source: 'FOO=$(echo "$(echo "$(echo "$(echo foo)")")")',
          literal: { FOO: '$(echo "$(echo "$(echo "$(echo foo)")")")' },
          expanded: { FOO: 'foo' },
        },
        {
          label: "quoted arguments",
          source: 'FOO=$(echo "Quotes won\'t be a problem")',
          literal: { FOO: '$(echo "Quotes won\'t be a problem")' },
          expanded: { FOO: "Quotes won't be a problem" },
        },
        {
          label: "command sees runtime env",
          source: 'FOO=bar\nBAR=$(echo "FOO is $FOO")',
          literal: { FOO: 'bar', BAR: '$(echo "FOO is bar")' },
          expanded: { FOO: 'bar', BAR: 'FOO is bar' },
        },
      ];

      for (const { label, source, literal, expanded } of cases) {
        it(label, () => {
          const defaultParser = new Dotenv();
          expect(defaultParser.parse(source)).toEqual(literal);

          const optInParser = new Dotenv();
          expect(optInParser.parse(`# @dotenv-expand-commands\n${source}`)).toEqual(expanded);
        });
      }
    });

    it("keeps literal when command execution fails", () => {
      const d = new Dotenv();
      const result = d.parse(`# @dotenv-expand-commands\nFOO=$((1dd2))`);
      expect(result.FOO).toBe("$((1dd2))");
    });
  }

  it("prefers existing env (APP_ENV) over inline for expansions/commands", () => {
    setEnv("APP_ENV", "prod");
    const d = new Dotenv();
    let vals = d.parse("APP_ENV=dev\nTEST1=foo1_${APP_ENV}");
    expect(vals.TEST1).toBe("foo1_prod");
    
    if (!isWindows && testCommandExpension) {
      vals = d.parse(`APP_ENV=dev\nTEST2=foo2_$(/bin/sh -c 'echo $APP_ENV')`);
      expect(vals.TEST2).toBe("foo2_$(/bin/sh -c 'echo $APP_ENV')");
      vals = d.parse(`# @dotenv-expand-commands\nAPP_ENV=dev\nTEST3=foo3_$(/bin/sh -c 'echo $APP_ENV')`);
      expect(vals.TEST3).toBe("foo3_prod");
    }

    delete process.env.APP_ENV;
  });

  it("reads from process.env via default (getenv analogue)", () => {
    setEnv("FOO", "Bar");
    const d = new Dotenv();
    const vals = d.parse('FOO=${FOO}');
    expect(vals.FOO).toBe("Bar");
    delete process.env.FOO;
  });
});

describe("Dotenv.load / overload", () => {
  afterEach(() => {
    resetAll(["FOO","BAR","NODE_DOTENV_VARS"]);
  });

  it("load multiple files", () => withTmpDir(tmp => {
    const p1 = path.join(tmp, "a.env");
    const p2 = path.join(tmp, "b.env");
    fs.writeFileSync(p1, "FOO=BAR");
    fs.writeFileSync(p2, "BAR=BAZ");

    new Dotenv().load(p1, p2);

    expect(process.env.FOO).toBe("BAR");
    expect(process.env.BAR).toBe("BAZ");
  }));

  it("overload overrides existing", () => withTmpDir(tmp => {
    setEnv("FOO", "initial_foo_value");
    setEnv("BAR", "initial_bar_value");

    const p1 = path.join(tmp, "a.env");
    const p2 = path.join(tmp, "b.env");
    fs.writeFileSync(p1, "FOO=BAR");
    fs.writeFileSync(p2, "BAR=BAZ");

    new Dotenv().overload(p1, p2);

    expect(process.env.FOO).toBe("BAR");
    expect(process.env.BAR).toBe("BAZ");
  }));

  it("load directory -> PathError", () => {
    const d = new Dotenv();
    expect(() => d.load(__dirname)).toThrowError(PathError);
  });
});

describe("Dotenv.loadEnv cascade & override semantics", () => {
  const resetContext = () => {
    resetAll(["NODE_DOTENV_VARS","FOO","TEST_APP_ENV","EXISTING_KEY"]);
    process.env.EXISTING_KEY = "EXISTING_VALUE";
  };

  it("mirrors .env, .env.local, .env.dev, .env.dev.local and .env.dist logic", () => withTmpDir(tmp => {
    const base = path.join(tmp, "base.env");
    fs.writeFileSync(base, "FOO=BAR\nEXISTING_KEY=NEW_VALUE");

    // .env
    resetContext();
    new Dotenv().loadEnv(base, "TEST_APP_ENV");
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.TEST_APP_ENV).toBe("dev");
    expect(process.env.EXISTING_KEY).toBe("EXISTING_VALUE");

    resetContext();
    new Dotenv().loadEnv(base, "TEST_APP_ENV", "dev", ["test"], true);
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.TEST_APP_ENV).toBe("dev");
    expect(process.env.EXISTING_KEY).toBe("NEW_VALUE");

    // .env.local
    fs.writeFileSync(`${base}.local`, "FOO=localBAR\nEXISTING_KEY=localNEW_VALUE");

    resetContext();
    process.env.TEST_APP_ENV = "local";
    new Dotenv().loadEnv(base, "TEST_APP_ENV");
    expect(process.env.FOO).toBe("localBAR");
    expect(process.env.EXISTING_KEY).toBe("EXISTING_VALUE");

    resetContext();
    process.env.TEST_APP_ENV = "local";
    new Dotenv().loadEnv(base, "TEST_APP_ENV", "dev", ["test"], true);
    expect(process.env.FOO).toBe("localBAR");
    expect(process.env.EXISTING_KEY).toBe("localNEW_VALUE");

    // test env ignores .env.local
    resetContext();
    process.env.TEST_APP_ENV = "test";
    new Dotenv().loadEnv(base, "TEST_APP_ENV");
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.EXISTING_KEY).toBe("EXISTING_VALUE");

    resetContext();
    process.env.TEST_APP_ENV = "test";
    new Dotenv().loadEnv(base, "TEST_APP_ENV", "dev", ["test"], true);
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.EXISTING_KEY).toBe("NEW_VALUE");

    // .env.dev
    fs.writeFileSync(`${base}.dev`, "FOO=devBAR\nEXISTING_KEY=devNEW_VALUE");

    resetContext();
    new Dotenv().loadEnv(base, "TEST_APP_ENV");
    expect(process.env.FOO).toBe("devBAR");
    expect(process.env.EXISTING_KEY).toBe("EXISTING_VALUE");

    resetContext();
    new Dotenv().loadEnv(base, "TEST_APP_ENV", "dev", ["test"], true);
    expect(process.env.FOO).toBe("devBAR");
    expect(process.env.EXISTING_KEY).toBe("devNEW_VALUE");

    // .env.dev.local
    fs.writeFileSync(`${base}.dev.local`, "FOO=devlocalBAR\nEXISTING_KEY=devlocalNEW_VALUE");

    resetContext();
    new Dotenv().loadEnv(base, "TEST_APP_ENV");
    expect(process.env.FOO).toBe("devlocalBAR");
    expect(process.env.EXISTING_KEY).toBe("EXISTING_VALUE");

    resetContext();
    new Dotenv().loadEnv(base, "TEST_APP_ENV", "dev", ["test"], true);
    expect(process.env.FOO).toBe("devlocalBAR");
    expect(process.env.EXISTING_KEY).toBe("devlocalNEW_VALUE");

    fs.rmSync(`${base}.local`);
    fs.rmSync(`${base}.dev`);
    fs.rmSync(`${base}.dev.local`);

    // .env.dist (fallback when base missing)
    fs.writeFileSync(`${base}.dist`, "FOO=distBAR\nEXISTING_KEY=distNEW_VALUE");

    resetContext();
    fs.rmSync(base); // delete base to force .dist
    new Dotenv().loadEnv(base, "TEST_APP_ENV");
    expect(process.env.FOO).toBe("distBAR");
    expect(process.env.EXISTING_KEY).toBe("EXISTING_VALUE");

    resetContext();
    new Dotenv().loadEnv(base, "TEST_APP_ENV", "dev", ["test"], true);
    expect(process.env.FOO).toBe("distBAR");
    expect(process.env.EXISTING_KEY).toBe("distNEW_VALUE");

    fs.rmSync(`${base}.dist`);
  }));
});

describe("populate semantics / sentinel var tracking", () => {
  afterEach(() => {
    resetAll(["NODE_DOTENV_VARS","APP_DEBUG","DATABASE_URL","DOCUMENT_ROOT","FOO","BAR","BAZ"]);
  });

  it("memorizes loaded vars in NODE_DOTENV_VARS", () => {
    delete process.env.NODE_DOTENV_VARS;
    delete process.env.APP_DEBUG;
    delete process.env.DATABASE_URL;

    const d = new Dotenv();
    d.populate({ APP_DEBUG: "1", DATABASE_URL: "mysql://root@localhost/db" });

    expect(process.env.NODE_DOTENV_VARS).toBe("APP_DEBUG,DATABASE_URL");

    process.env.NODE_DOTENV_VARS = "APP_ENV";
    process.env.APP_DEBUG = "1";
    delete process.env.DATABASE_URL;

    d.populate({ APP_DEBUG: "0", DATABASE_URL: "mysql://root@localhost/db" });
    d.populate({ DATABASE_URL: "sqlite:///somedb.sqlite" });

    expect(process.env.NODE_DOTENV_VARS).toBe("APP_ENV,DATABASE_URL");
  });

  it("overrides only memorized names, not arbitrary server vars", () => {
    process.env.NODE_DOTENV_VARS = "FOO,BAR,BAZ";
    process.env.FOO = "foo";
    process.env.BAR = "bar";
    process.env.BAZ = "baz";
    process.env.DOCUMENT_ROOT = "/var/www";

    const d = new Dotenv();
    d.populate({ FOO: "foo1", BAR: "bar1", BAZ: "baz1", DOCUMENT_ROOT: "/boot" });

    expect(process.env.FOO).toBe("foo1");
    expect(process.env.BAR).toBe("bar1");
    expect(process.env.BAZ).toBe("baz1");
    expect(process.env.DOCUMENT_ROOT).toBe("/var/www");
  });

  it("doNotUsePutenv analogue — process.env only", () => {
    const d = new Dotenv();
    d.populate({ TEST_USE_PUTENV: "no" });
    expect(process.env.TEST_USE_PUTENV).toBe("no");
  });
});

describe("bootEnv", () => {
  const resetContext = () => {
    resetAll(["NODE_DOTENV_VARS","TEST_APP_ENV","TEST_APP_DEBUG","FOO","EXISTING_KEY"]);
    process.env.EXISTING_KEY = "EXISTING_VALUE";
  };

  it("loads .env then computes APP_DEBUG and respects overrideExisting", () => withTmpDir(tmp => {
    const base = path.join(tmp, "base.env");
    fs.writeFileSync(base, "FOO=BAR\nEXISTING_KEY=NEW_VALUE");

    resetContext();
    new Dotenv("TEST_APP_ENV","TEST_APP_DEBUG").bootEnv(base);
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.EXISTING_KEY).toBe("EXISTING_VALUE");
    expect(process.env.TEST_APP_DEBUG).toBe("1"); // dev => debug=1

    resetContext();
    new Dotenv("TEST_APP_ENV","TEST_APP_DEBUG").bootEnv(base, "dev", ["test"], true);
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.EXISTING_KEY).toBe("NEW_VALUE");
  }));

  it("loads <path>.local.cjs map first when compatible", () => withTmpDir(tmp => {
    const base = path.join(tmp, "base.env");
    fs.writeFileSync(base, "FOO=BAR\nEXISTING_KEY=NEW_VALUE");
    const localCjs = `${base}.local.cjs`;
    fs.writeFileSync(localCjs, `module.exports = { TEST_APP_ENV: "dev", FOO: "BAR", EXISTING_KEY: "localphpNEW_VALUE" };`);

    const resetContext = () => {
      resetAll(["NODE_DOTENV_VARS","TEST_APP_ENV","TEST_APP_DEBUG","FOO","EXISTING_KEY"]);
      process.env.EXISTING_KEY = "EXISTING_VALUE";
    };

    resetContext();
    new Dotenv("TEST_APP_ENV","TEST_APP_DEBUG").bootEnv(base);
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.TEST_APP_DEBUG).toBe("1");
    expect(process.env.EXISTING_KEY).toBe("EXISTING_VALUE");

    resetContext();
    new Dotenv("TEST_APP_ENV","TEST_APP_DEBUG").bootEnv(base, "dev", ["test"], true);
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.TEST_APP_DEBUG).toBe("1");
    expect(process.env.EXISTING_KEY).toBe("localphpNEW_VALUE");
  }));

  it("respects pre-set env and overrideExisting", () => withTmpDir(tmp => {
    const base = path.join(tmp, "base.env");
    fs.writeFileSync(base, "FOO=BAR\nEXISTING_KEY=NEW_VALUE");
    const localCjs = `${base}.local.cjs`;
    fs.writeFileSync(localCjs, `module.exports = { TEST_APP_ENV: "dev", FOO: "BAR", EXISTING_KEY: "localphpNEW_VALUE" };`);

    resetAll(["NODE_DOTENV_VARS","TEST_APP_ENV","TEST_APP_DEBUG","FOO","EXISTING_KEY"]);
    process.env.TEST_APP_ENV = "ccc";
    process.env.EXISTING_KEY = "EXISTING_VALUE";

    new Dotenv("TEST_APP_ENV","TEST_APP_DEBUG").bootEnv(base, "dev", ["test"], true);
    expect(process.env.FOO).toBe("BAR");
    expect(process.env.TEST_APP_DEBUG).toBe("1");
    expect(process.env.EXISTING_KEY).toBe("localphpNEW_VALUE");
  }));
});

describe("BOM handling", () => {
  it("throws on BOM", () => withTmpDir(tmp => {
    const p = path.join(tmp, "bom.env");
    const bom = Buffer.from([0xef,0xbb,0xbf]);
    fs.writeFileSync(p, Buffer.concat([bom, Buffer.from("FOO=BAR")]));
    const d = new Dotenv();
    expect(() => d.load(p)).toThrowError(FormatError);
  }));
});
