const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.contains(value) : !!force;
    enabled ? this.add(value) : this.remove(value);
    return enabled;
  }
}

class FakeElement {
  constructor() {
    this.classList = new FakeClassList();
    this.dataset = {};
    this.children = [];
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.textContent = "";
    this._innerHTML = "";
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = String(value); if (!value) this.children = []; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    this.scrollHeight = this.children.length;
    return child;
  }
  append(value) { this.textContent += String(value); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
  }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function loadEditor() {
  const htmlPath = path.join(__dirname, "..", "narrative_editor_demo.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const runtimeSource = source.slice(0, source.indexOf("// EDITOR_BINDINGS"));
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  };
  const document = {
    body: element("body"),
    querySelector: selector => element(selector),
    querySelectorAll: () => [],
    createElement: () => new FakeElement()
  };
  const context = {
    console,
    document,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    performance,
    requestAnimationFrame: callback => setImmediate(() => callback(performance.now())),
    cancelAnimationFrame: handle => clearImmediate(handle),
    setTimeout,
    clearTimeout,
    Blob,
    URL,
    CSS: { escape: value => String(value) },
    confirm: () => true,
    alert: () => {}
  };
  vm.createContext(context);
  vm.runInContext(runtimeSource + `
    render=()=>{};
    globalThis.__editorTest={
      normalize,
      projectIssues,
      deleteScript,
      getDialogueRef,
      resourceNav,
      textSegments,
      assertProjectShape,
      activate,
      emit,
      startRun,
      pushLog(text){log(text)},
      limits:{MAX_REVEAL_MS,MAX_TEXT,MAX_LOG,MAX_ENTITIES},
      get project(){return project},
      get runtime(){return runtime},
      setProject(value){project=normalize(value);rebuildIndexes();runtime=freshRuntime(0);selectedScript=project.scripts[0]?.id||""}
    };
  `, context);
  return { api: context.__editorTest, elements, html };
}

const emptyProject = () => ({
  scripts: [],
  events: [],
  conditions: [],
  variables: [],
  tags: [{ id: "TAG", name: "默认", color: "#ffffff", effect: "none", output: "plain" }]
});

async function main() {
  const { api, elements, html } = loadEditor();
  assert.equal(api.projectIssues().filter(issue => issue.level === "error").length, 0, "sample project must have no structural errors");
  const eventNav = api.resourceNav("event", api.project.events, api.project.events[0].id, "");
  assert(eventNav.includes('role="listbox"') && eventNav.includes("resource-resizer"), "resources need a vertical list and resize handle");
  assert(!html.includes(".inspector-pane .resource-list{display:flex"), "the old horizontal resource strip must stay removed");
  assert(html.includes('indexedDB.open("interactive-script-orchestrator"') && html.includes('id="saveStatus"'), "autosave needs durable storage and visible failure status");
  assert(html.includes('root.querySelectorAll(".topbar,.workspace,.ledger")') && html.includes("if(!PLAYABLE){bind"), "playable export must strip editor DOM and skip editor bindings");

  const migrated = api.normalize({
    ...emptyProject(),
    tags: [],
    scripts: [{
      id: "S", title: "旧数据", output: "main", mode: "once", condition: "",
      dialogues: [{ id: "D", text: "x", speaker: "旧标签", color: "red;background:url(x)", effect: "shake" }],
      buttons: [], onStart: [], onComplete: []
    }]
  });
  assert.equal(migrated.tags[0].color, "#d9e8df", "legacy tag colors must be sanitized");
  assert.equal(migrated.scripts[0].items[0].delay, 0);
  const hostilePositions = JSON.parse('{"__proto__":{"x":1,"y":1}}');
  const normalizedPositions = api.normalize({ ...emptyProject(), ui: { graphPositions: { all: hostilePositions, local: {} }, resourceBrowser: { height: 99999, collapsed: true } } });
  assert.equal(Object.getPrototypeOf(normalizedPositions.ui.graphPositions.all), null, "graph position dictionaries must not inherit object prototypes");
  assert.equal(normalizedPositions.ui.resourceBrowser.height, 420, "resource browser height must stay inside its usable range");
  assert.equal(normalizedPositions.ui.resourceBrowser.collapsed, true);
  assert.equal(api.textSegments("A👨‍👩‍👧‍👦B").length, 3, "typewriter must preserve grapheme clusters");

  const oversizedText = "x".repeat(api.limits.MAX_TEXT + 1);
  const bounded = emptyProject();
  bounded.scripts = [{ id: "S", title: "bounded", output: "main", mode: "once", condition: "", onStart: [], onComplete: [], items: [
    { id: "D", type: "dialogue", tag: "TAG", text: oversizedText, reveal: 999999999, appear: "sequence", delay: 0, condition: "", emit: "", emitWhen: "complete", lifetime: "persistent", duration: 0, destroyEvent: "" }
  ] }];
  const boundedResult = api.normalize(bounded);
  assert.equal(boundedResult.scripts[0].items[0].text.length, api.limits.MAX_TEXT, "dialogue text must be bounded");
  assert.equal(boundedResult.scripts[0].items[0].reveal, api.limits.MAX_REVEAL_MS, "reveal animations must not run indefinitely");
  assert.throws(() => api.assertProjectShape({ scripts: Array.from({ length: api.limits.MAX_ENTITIES + 1 }, () => ({})) }), /数量超过/, "oversized imports must be rejected before normalization");

  const delimited = emptyProject();
  delimited.scripts = [{ id: "S::X", title: "delimiter", output: "main", mode: "once", condition: "", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [
    { id: "D", type: "dialogue", tag: "TAG", text: "x", appear: "event", delay: 0, reveal: 0, condition: "", emit: "", emitWhen: "complete", lifetime: "persistent", duration: 0, destroyEvent: "" }
  ] }];
  api.setProject(delimited);
  assert.equal(api.getDialogueRef("S::X::D").item.id, "D");
  assert(api.projectIssues().some(issue => issue.title.includes("保留分隔符")));

  const deletion = emptyProject();
  deletion.scripts = [
    { id: "S1", title: "one", output: "main", mode: "once", condition: "", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [] },
    { id: "S2", title: "two", output: "main", mode: "once", condition: "", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [] }
  ];
  deletion.events = [{ id: "EV", name: "event", condition: "", actions: [
    { id: "A1", type: "emit", target: "S1", returnTo: "", condition: "" },
    { id: "A2", type: "setVariable", target: "S1", value: 1, returnTo: "", condition: "" },
    { id: "A3", type: "activate", target: "S1", returnTo: "", condition: "" },
    { id: "A4", type: "call", target: "S2", returnTo: "S1", condition: "" }
  ] }];
  api.setProject(deletion);
  api.deleteScript("S1");
  assert.deepEqual(Array.from(api.project.events[0].actions, action => action.id), ["A1", "A2", "A4"]);
  assert.equal(api.project.events[0].actions[2].returnTo, "", "deleting a return target must retain the call");

  const invalidReturn = emptyProject();
  invalidReturn.scripts = [{ id: "S", title: "one", output: "main", mode: "once", condition: "", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [] }];
  invalidReturn.events = [{ id: "EV", name: "event", condition: "", actions: [{ id: "A", type: "call", target: "S", returnTo: "MISSING", condition: "" }] }];
  api.setProject(invalidReturn);
  assert(api.projectIssues().some(issue => issue.title.includes("返回脚本不存在")));

  const flow = emptyProject();
  flow.scripts = [
    { id: "MAIN", title: "main", output: "main", mode: "once", condition: "", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [
      { id: "D1", type: "dialogue", tag: "TAG", text: "before", appear: "sequence", delay: 0, reveal: 0, condition: "", emit: "", emitWhen: "complete", lifetime: "persistent", duration: 0, destroyEvent: "" },
      { id: "BF", type: "button", label: "temporary", condition: "", event: "", appear: "sequence", showEvent: "", delay: 0, lifetime: "fixed", duration: 20, hideEvent: "", keepCondition: "", blocking: false, repeat: false },
      { id: "BH", type: "button", label: "until event", condition: "", event: "", appear: "sequence", showEvent: "", delay: 0, lifetime: "event", duration: 0, hideEvent: "HIDE", keepCondition: "", blocking: false, repeat: false },
      { id: "B1", type: "button", label: "open", condition: "", event: "OPEN", appear: "sequence", showEvent: "", delay: 0, lifetime: "click", duration: 0, hideEvent: "", keepCondition: "", blocking: true, repeat: false },
      { id: "D2", type: "dialogue", tag: "TAG", text: "after", appear: "sequence", delay: 0, reveal: 0, condition: "", emit: "", emitWhen: "complete", lifetime: "persistent", duration: 0, destroyEvent: "" }
    ] },
    { id: "PANEL", title: "panel", output: "panel", mode: "reusable", condition: "", panelKind: "generic", panelGroup: "phone", onStart: [], onComplete: [], items: [] }
  ];
  flow.events = [
    { id: "OPEN", name: "open", condition: "", actions: [{ id: "A1", type: "panel", target: "PANEL", returnTo: "MAIN", condition: "" }] },
    { id: "HIDE", name: "hide", condition: "", actions: [] },
    { id: "RETURN", name: "return", condition: "", actions: [{ id: "A2", type: "return", target: "", returnTo: "", condition: "" }] }
  ];
  api.setProject(flow);
  const running = api.activate("MAIN");
  await new Promise(resolve => setTimeout(resolve, 5));
  const button = api.runtime.liveButtons.get("B1").el;
  await button.onclick();
  await running;
  await api.emit("HIDE");
  await new Promise(resolve => setTimeout(resolve, 25));
  await api.emit("RETURN");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(api.runtime.completed.has("MAIN"), true, "main script must finish after returning from a panel");
  assert.equal(api.runtime.liveButtons.has("BF"), false, "fixed button deadlines must continue while a panel is open");
  assert.equal(api.runtime.liveButtons.has("BH"), false, "event-ended buttons must stay dismissed while away");
  assert.deepEqual(elements.get("#runtimeScreen").children.map(child => child.textContent), ["before", "after"]);

  const gated = emptyProject();
  gated.scripts = [{ id: "GATED", title: "gated", output: "main", mode: "once", condition: "NEEDS_EVENT", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [
    { id: "DG", type: "dialogue", tag: "TAG", text: "debug entry", appear: "sequence", delay: 0, reveal: 0, condition: "", emit: "", emitWhen: "complete", lifetime: "persistent", duration: 0, destroyEvent: "" }
  ] }];
  gated.events = [{ id: "PREREQUISITE", name: "prerequisite", condition: "", actions: [] }];
  gated.conditions = [{ id: "NEEDS_EVENT", name: "needs event", mode: "all", rules: [{ id: "R", source: "event", event: "PREREQUISITE", variable: "", op: ">=", value: 1 }] }];
  api.setProject(gated);
  assert.equal(await api.activate("GATED"), false, "normal activation must still enforce entry conditions");
  assert.equal(await api.startRun("GATED", true), true, "run-from-here must bypass only the selected entry condition");
  assert.equal(api.runtime.completed.has("GATED"), true);
  assert(api.runtime.log.some(entry => entry.text.includes("已忽略当前脚本进入条件")));

  const duplicate = emptyProject();
  duplicate.scripts = [
    { id: "DUP", title: "one", output: "main", mode: "once", condition: "", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [] },
    { id: "DUP", title: "two", output: "main", mode: "once", condition: "", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [] }
  ];
  api.setProject(duplicate);
  assert.equal(await api.startRun("DUP"), false, "structural errors must block ambiguous runtime execution");

  api.setProject(emptyProject());
  for (let index = 0; index < api.limits.MAX_LOG + 25; index++) api.pushLog(String(index));
  assert.equal(api.runtime.log.length, api.limits.MAX_LOG, "runtime logs must use a bounded buffer");

  const decimalFlow = emptyProject();
  decimalFlow.variables = [{ id: "DECIMAL", name: "decimal", initial: 0.1 }];
  decimalFlow.events = [{ id: "ADD", name: "add", condition: "", actions: [{ id: "A", type: "addVariable", target: "DECIMAL", value: 0.2, returnTo: "", condition: "" }] }];
  api.setProject(decimalFlow);
  await api.emit("ADD");
  assert.equal(api.runtime.variables.DECIMAL, 0.3, "decimal variable addition must avoid common binary drift");

  const repeatFlow = emptyProject();
  repeatFlow.scripts = [{ id: "REPEAT", title: "repeat", output: "main", mode: "reusable", condition: "", panelKind: "generic", panelGroup: "", onStart: [], onComplete: [], items: [
    { id: "BR", type: "button", label: "again", condition: "", event: "", appear: "sequence", showEvent: "", delay: 0, lifetime: "click", duration: 0, hideEvent: "", keepCondition: "", blocking: false, repeat: true }
  ] }];
  api.setProject(repeatFlow);
  await api.activate("REPEAT");
  await new Promise(resolve => setTimeout(resolve, 5));
  const repeatButton = api.runtime.liveButtons.get("BR").el;
  await repeatButton.onclick();
  assert.equal(api.runtime.liveButtons.has("BR"), true, "repeat buttons must survive click lifetime");

  console.log("Self-checks passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
