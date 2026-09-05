#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(here, "../ui/obsidian-template.html");

function fail(message) {
  throw new Error(`LEARN renderer: ${message}`);
}

function safePath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`path escapes the workspace: ${relativePath}`);
  }
  return resolved;
}

async function safeExistingPath(root, relativePath) {
  const actual = await realpath(safePath(root, relativePath));
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) fail(`symlink escapes the workspace: ${relativePath}`);
  return actual;
}

async function canonicalOutputPath(value) {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
}

function optionalText(value, label) {
  if (value !== undefined && typeof value !== "string") fail(`${label} must be a string`);
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateArtifact(artifact) {
  requireObject(artifact, "artifact metadata");
  validateId(artifact.id, "artifact ID");
  validateId(artifact.conceptId, "artifact concept ID");
  requireText(artifact.title, `artifact title (${artifact.id})`);
  requireText(artifact.path, `artifact path (${artifact.id})`);
  for (const field of ["summary", "updatedAt"]) optionalText(artifact[field], `artifact ${field} (${artifact.id})`);
  if (!Array.isArray(artifact.labels) || !artifact.labels.length || artifact.labels.some((label) => !["canonical", "external", "conflict"].includes(label))) {
    fail(`artifact labels must be a non-empty array containing only canonical, external, or conflict: ${artifact.id}`);
  }
  if (!Array.isArray(artifact.citations) || !artifact.citations.length) fail(`artifact requires citations: ${artifact.id}`);
  for (const citation of artifact.citations) {
    requireObject(citation, `citation on artifact ${artifact.id}`);
    optionalText(citation.note, `citation note on artifact ${artifact.id}`);
    if (citation.sourceId !== undefined) {
      validateId(citation.sourceId, `citation source ID on artifact ${artifact.id}`);
      requireText(citation.locator, `canonical citation locator on artifact ${artifact.id}`);
      if (citation.href !== undefined || citation.label !== undefined) fail(`canonical citation cannot contain href or label: ${artifact.id}`);
    } else {
      requireText(citation.label, `external citation label on artifact ${artifact.id}`);
      requireText(citation.href, `external citation href on artifact ${artifact.id}`);
      if (!isHttpsUrl(citation.href)) fail(`external citation href must be an absolute HTTPS URL without credentials: ${artifact.id}`);
      if (citation.locator !== undefined) fail(`external citation cannot contain locator: ${artifact.id}`);
    }
  }
}

function validateGraph(nodes, edges, knownSet, sourceIds, allowMissingSources = false) {
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(knownSet)) fail("graph nodes, edges, and known set must be arrays");
  for (const node of nodes) {
    requireObject(node, "concept");
    if (Object.keys(node).some((key) => !["id", "label", "description", "sourceIds"].includes(key))) fail(`concept contains a non-semantic field: ${node.id}`);
    validateId(node.id, "concept ID");
    requireText(node.label, `concept label (${node.id})`);
    requireText(node.description, `concept description (${node.id})`);
    if (!Array.isArray(node.sourceIds) || !node.sourceIds.length) fail(`concept is not grounded in a source: ${node.id}`);
    for (const sourceId of node.sourceIds) {
      validateId(sourceId, `source ID on concept ${node.id}`);
      if (!allowMissingSources && !sourceIds.has(sourceId)) fail(`concept references an unknown source: ${node.id} -> ${sourceId}`);
    }
  }
  const ids = new Set(nodes.map(({ id }) => id));
  if (ids.size !== nodes.length) fail("concept IDs must be unique");

  const indegree = new Map(nodes.map(({ id }) => [id, 0]));
  const dependents = new Map(nodes.map(({ id }) => [id, []]));
  const edgeKeys = new Set();
  for (const edge of edges) {
    requireObject(edge, "prerequisite edge");
    if (Object.keys(edge).some((key) => !["from", "to", "sourceIds"].includes(key))) fail(`prerequisite edge contains a non-semantic field: ${edge.from} -> ${edge.to}`);
    const { from, to, sourceIds: edgeSourceIds } = edge;
    if (!ids.has(from) || !ids.has(to)) fail(`edge references an unknown concept: ${from} -> ${to}`);
    if (from === to) fail(`concept cannot be its own prerequisite: ${from}`);
    if (!Array.isArray(edgeSourceIds) || !edgeSourceIds.length) fail(`prerequisite edge is not grounded in a source: ${from} -> ${to}`);
    for (const sourceId of edgeSourceIds) {
      validateId(sourceId, `source ID on edge ${from} -> ${to}`);
      if (!allowMissingSources && !sourceIds.has(sourceId)) fail(`edge references an unknown source: ${from} -> ${to} -> ${sourceId}`);
    }
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) fail(`duplicate prerequisite edge: ${from} -> ${to}`);
    edgeKeys.add(key);
    indegree.set(to, indegree.get(to) + 1);
    dependents.get(from).push(to);
  }

  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.pop();
    visited += 1;
    for (const dependent of dependents.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
  }
  if (visited !== nodes.length) fail("concept graph contains a prerequisite cycle");

  if (new Set(knownSet).size !== knownSet.length) fail("known set contains duplicate concept IDs");
  for (const id of knownSet) {
    if (!ids.has(id)) fail(`known set references an unknown concept: ${id}`);
  }

  const known = new Set(knownSet);
  for (const { from, to } of edges) {
    if (known.has(to) && !known.has(from)) {
      fail(`known set is prerequisite-inconsistent: ${to} requires ${from}`);
    }
  }
}

function findFrontier(nodes, edges, knownSet) {
  const known = new Set(knownSet);
  const prerequisites = new Map(nodes.map(({ id }) => [id, []]));
  for (const { from, to } of edges) prerequisites.get(to).push(from);
  return nodes
    .map(({ id }) => id)
    .filter((id) => !known.has(id) && prerequisites.get(id).every((prerequisite) => known.has(prerequisite)));
}

async function loadTopic(workspaceRoot, topicRef) {
  const topicRoot = await safeExistingPath(workspaceRoot, topicRef.path);
  const [topic, graph, knownState] = await Promise.all([
    safeExistingPath(topicRoot, "topic.json").then(readJson),
    safeExistingPath(topicRoot, "concept_graph.json").then(readJson),
    safeExistingPath(topicRoot, "known_set.json").then(readJson),
  ]);
  requireObject(topic, "topic metadata");
  requireObject(knownState, "known set");
  requireText(topic.title, "topic title");
  for (const field of ["eyebrow", "summary", "updatedAt"]) optionalText(topic[field], `topic ${field}`);
  if (typeof topic.graphReconciliationRequired !== "boolean") fail("topic graphReconciliationRequired must be boolean");
  if (!Array.isArray(topic.sources) || !Array.isArray(topic.artifacts)) fail("topic sources and artifacts must be arrays");
  if (!Array.isArray(knownState.conceptIds)) fail("known set conceptIds must be an array");
  const knownSet = knownState.conceptIds;
  for (const source of topic.sources) {
    requireObject(source, "source metadata");
    validateId(source.id, "source ID");
    requireText(source.title, `source title (${source.id})`);
    requireText(source.type, `source type (${source.id})`);
    requireText(source.path, `source path (${source.id})`);
    for (const field of ["author", "locator", "addedAt"]) optionalText(source[field], `source ${field} (${source.id})`);
  }
  const sourceIds = new Set(topic.sources.map(({ id }) => id));
  if (sourceIds.size !== topic.sources.length) fail("source IDs must be unique");
  validateGraph(graph.nodes, graph.edges, knownSet, sourceIds, Boolean(topic.graphReconciliationRequired));

  const sources = await Promise.all(topic.sources.map(async (source) => ({
    ...source,
    markdown: await readFile(await safeExistingPath(topicRoot, source.path), "utf8"),
  })));
  const artifactIds = new Set();
  const artifactConceptIds = new Set();
  // Output-only artifacts may intentionally outlive a source or concept removal.
  for (const artifact of topic.artifacts) {
    validateArtifact(artifact);
    if (artifactIds.has(artifact.id)) fail(`duplicate artifact ID: ${artifact.id}`);
    if (artifactConceptIds.has(artifact.conceptId)) fail(`concept has more than one learning artifact: ${artifact.conceptId}`);
    artifactIds.add(artifact.id);
    artifactConceptIds.add(artifact.conceptId);
  }
  const artifacts = await Promise.all(topic.artifacts.map(async (artifact) => ({
    ...artifact,
    html: await readFile(await safeExistingPath(topicRoot, artifact.path), "utf8"),
  })));

  return {
    topic: {
      title: topic.title,
      eyebrow: topic.eyebrow,
      summary: topic.summary,
      updatedAt: topic.updatedAt,
      graphReconciliationRequired: Boolean(topic.graphReconciliationRequired),
    },
    graph: {
      nodes: graph.nodes,
      edges: graph.edges,
      frontierIds: findFrontier(graph.nodes, graph.edges, knownSet),
    },
    knownSet,
    sources,
    artifacts,
  };
}

function pageName(projectId, topicId) {
  return `${projectId.length}-${projectId}--${topicId.length}-${topicId}.html`;
}

function validateId(id, label) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) fail(`${label} must use lowercase letters, digits, hyphens, or underscores: ${id}`);
}

function inject(template, data) {
  const token = "__LEARN_DATA__";
  if (template.split(token).length !== 2) fail(`template must contain exactly one ${token} token`);
  const json = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return template.replace(token, json);
}

function validateSession(session, loaded) {
  requireObject(session, "ephemeral session payload");
  if (session.active !== true) fail("ephemeral session payload must set active to true");
  const kinds = new Set(["quiz", "boundary-proposal", "revision-result", "graph-proposal", "answer"]);
  if (!kinds.has(session.kind)) fail(`unknown ephemeral session kind: ${session.kind}`);
  if (session.html !== undefined && typeof session.html !== "string") fail("session html must be a string");
  if (session.kind === "quiz") {
    if (!new Set(["boundary", "revision"]).has(session.type)) fail("quiz type must be boundary or revision");
    if (!Number.isInteger(session.current) || session.current < 1 || typeof session.question !== "string" || !session.question.trim()) fail("quiz requires a one-based current question number and question text");
  }
  const graphDependentKinds = new Set(["quiz", "boundary-proposal", "revision-result"]);
  if (loaded.topic.graphReconciliationRequired && graphDependentKinds.has(session.kind)) {
    fail(`${session.kind} is blocked while graph reconciliation is required`);
  }
  if (session.proposedGraph !== undefined && session.kind !== "graph-proposal") fail("proposedGraph is valid only for graph-proposal");
  if (session.proposedKnownSet !== undefined && !["boundary-proposal", "revision-result", "graph-proposal"].includes(session.kind)) {
    fail(`proposedKnownSet is not valid for ${session.kind}`);
  }
  if (["boundary-proposal", "revision-result", "graph-proposal"].includes(session.kind) && !Array.isArray(session.proposedKnownSet)) {
    fail(`${session.kind} requires proposedKnownSet`);
  }
  if (session.kind === "graph-proposal" && !session.proposedGraph) fail("graph-proposal requires proposedGraph");
  if (session.kind === "graph-proposal" && !loaded.topic.graphReconciliationRequired) fail("graph-proposal requires graph reconciliation to be pending");
  if (session.kind === "answer" && !(typeof session.html === "string" && session.html.trim())) fail("answer requires html");
  const sourceIds = new Set(loaded.sources.map(({ id }) => id));
  const proposedGraph = session.proposedGraph;
  const proposedKnownSet = session.proposedKnownSet ?? loaded.knownSet;
  if (proposedGraph) {
    if (!Array.isArray(proposedGraph.nodes) || !Array.isArray(proposedGraph.edges)) fail("proposed graph must contain node and edge arrays");
    validateGraph(proposedGraph.nodes, proposedGraph.edges, proposedKnownSet, sourceIds);
  } else if (session.proposedKnownSet) {
    validateGraph(loaded.graph.nodes, loaded.graph.edges, proposedKnownSet, sourceIds);
  }
  if (session.sourceRefs !== undefined && !Array.isArray(session.sourceRefs)) fail("session sourceRefs must be an array");
  for (const ref of session.sourceRefs ?? []) {
    requireObject(ref, "session source reference");
    if (!sourceIds.has(ref.sourceId)) fail(`session output references an unknown source: ${ref.sourceId}`);
    requireText(ref.locator, `session source locator (${ref.sourceId})`);
  }
}

async function replaceDirectory(outputRoot, pages) {
  const parent = path.dirname(outputRoot);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, `.${path.basename(outputRoot)}-new-`));
  const previous = `${outputRoot}.previous-${process.pid}-${Date.now()}`;
  let movedPrevious = false;
  try {
    await Promise.all([...pages].map(([name, html]) => writeFile(path.join(temporary, name), html)));
    try { await rename(outputRoot, previous); movedPrevious = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, outputRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (movedPrevious) {
      try { await rename(previous, outputRoot); } catch {}
    }
    throw error;
  }
  if (movedPrevious) await rm(previous, { recursive: true, force: true });
}

async function render(workspaceRootArg, outputRootArg, sessionPathArg) {
  const workspaceRoot = await realpath(path.resolve(workspaceRootArg));
  const outputRoot = await canonicalOutputPath(outputRootArg ?? path.join(workspaceRoot, "html"));
  const sessionPath = sessionPathArg ? await realpath(path.resolve(sessionPathArg)) : undefined;
  const insideWorkspace = (candidate) => candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${path.sep}`);
  if (sessionPath) {
    if (insideWorkspace(outputRoot) || insideWorkspace(sessionPath)) fail("ephemeral session input and output must both be outside the durable workspace");
    if (path.basename(sessionPath) !== "session.json" || outputRoot !== path.join(path.dirname(sessionPath), "rendered")) {
      fail("ephemeral session must use one temporary directory containing session.json and rendered/");
    }
  } else if (outputRoot !== path.join(workspaceRoot, "html")) {
    fail("durable output must be <workspace-root>/html");
  }
  const [workspace, template] = await Promise.all([
    safeExistingPath(workspaceRoot, "workspace.json").then(readJson),
    readFile(templatePath, "utf8"),
  ]);
  const session = sessionPath ? await readJson(sessionPath) : undefined;
  if (!Array.isArray(workspace.projects)) fail("workspace projects must be an array");
  const projectIds = new Set();
  for (const project of workspace.projects) {
    validateId(project.id, "project ID");
    if (projectIds.has(project.id)) fail(`duplicate project ID: ${project.id}`);
    projectIds.add(project.id);
    if (!Array.isArray(project.topics)) fail(`project topics must be an array: ${project.id}`);
    const topicIds = new Set();
    for (const topic of project.topics) {
      validateId(topic.id, "topic ID");
      if (topicIds.has(topic.id)) fail(`duplicate topic ID in ${project.id}: ${topic.id}`);
      topicIds.add(topic.id);
    }
  }
  const refs = workspace.projects.flatMap((project) =>
    project.topics.map((topic) => ({ ...topic, projectId: project.id })),
  );
  if (!refs.length) fail("workspace has no topics");
  const refKeys = new Set(refs.map(({ projectId, id }) => `${projectId}/${id}`));
  const current = workspace.current ?? { projectId: refs[0].projectId, topicId: refs[0].id };
  if (!refKeys.has(`${current.projectId}/${current.topicId}`)) fail("workspace current topic does not exist");

  const navProjects = workspace.projects.map((project) => ({
    id: project.id,
    name: project.name,
    topics: project.topics.map(({ id, name }) => ({
      id,
      name,
      href: `./${pageName(project.id, id)}`,
    })),
  }));

  const pages = new Map();
  for (const ref of refs) {
    const loaded = await loadTopic(workspaceRoot, ref);
    const isCurrent = current.projectId === ref.projectId && current.topicId === ref.id;
    if (session && isCurrent) validateSession(session, loaded);
    const data = {
      workspace: {
        name: workspace.name,
        projects: navProjects.map((project) => ({
          ...project,
          topics: project.topics.map((topic) => ({
            ...topic,
            active: project.id === ref.projectId && topic.id === ref.id,
          })),
        })),
      },
      current: { projectId: ref.projectId, topicId: ref.id },
      ...loaded,
      ...(session && isCurrent
        ? { session }
        : {}),
    };
    pages.set(pageName(ref.projectId, ref.id), inject(template, data));
  }

  const activePage = pageName(current.projectId, current.topicId);
  pages.set("index.html", pages.get(activePage));
  await replaceDirectory(outputRoot, pages);
  console.log(`Rendered ${refs.length} topic${refs.length === 1 ? "" : "s"} to ${outputRoot}`);
  if (session) console.log("Ephemeral session UI rendered outside the workspace; remove the directory when the session output ends.");
}

async function check() {
  const template = await readFile(templatePath, "utf8");
  assert.equal(template.split("__LEARN_DATA__").length, 2);
  for (const marker of ['id="graph-canvas"', 'id="note-empty"', 'id="learn-data"', "mass: nodeRadius * nodeRadius", "requestAnimationFrame(runSimulation)", "context.lineTo(baseX - uy * halfWidth"]) assert.ok(template.includes(marker));
  const nodes = ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase(), description: `${id} description`, sourceIds: ["s"] }));
  const edges = [{ from: "a", to: "b", sourceIds: ["s"] }, { from: "b", to: "c", sourceIds: ["s"] }];
  validateGraph(nodes, edges, ["a"], new Set(["s"]));
  assert.deepEqual(findFrontier(nodes, edges, ["a"]), ["b"]);
  assert.throws(() => validateGraph(nodes, edges, ["b"], new Set(["s"])), /prerequisite-inconsistent/);
  assert.throws(() => validateGraph(nodes, [...edges, { from: "c", to: "a", sourceIds: ["s"] }], [], new Set(["s"])), /cycle/);
  assert.throws(() => validateGraph([{ id: "a", label: "A", description: "A description", sourceIds: ["removed"] }], [], [], new Set()), /unknown source/);
  validateGraph([{ id: "a", label: "A", description: "A description", sourceIds: ["removed"] }], [], [], new Set(), true);
  assert.throws(() => validateGraph([{ id: "a", description: "A description", sourceIds: ["s"] }], [], [], new Set(["s"])), /concept label/);
  assert.throws(() => validateGraph([{ ...nodes[0], x: 10 }], [], [], new Set(["s"])), /non-semantic field/);
  assert.throws(() => validateGraph(nodes, [{ ...edges[0], color: "red" }], [], new Set(["s"])), /non-semantic field/);
  assert.throws(() => validateId("../escape", "test ID"), /must use/);
  assert.notEqual(pageName("a--b", "c"), pageName("a", "b--c"));
  validateArtifact({ id: "lesson", conceptId: "a", title: "Lesson", path: "html/artifacts/lesson.html", labels: ["canonical"], citations: [{ sourceId: "s", locator: "§1" }] });
  assert.throws(() => validateArtifact({ id: "lesson", conceptId: "a", title: "Lesson", path: "lesson.html", labels: ["canonical"], citations: [{ sourceId: "s", locator: "§1", href: "https://example.com" }] }), /cannot contain href/);
  assert.throws(() => validateArtifact({ id: "lesson", conceptId: "a", title: "Lesson", path: "lesson.html", labels: ["external"], citations: [{ label: "Local", href: "../secret" }] }), /absolute HTTPS/);
  const loaded = { topic: { graphReconciliationRequired: false }, sources: [{ id: "s" }], knownSet: ["a"], graph: { nodes, edges } };
  validateSession({ active: true, kind: "quiz", type: "boundary", current: 1, question: "Why?", sourceRefs: [{ sourceId: "s", locator: "§1" }] }, loaded);
  assert.throws(() => validateSession({ active: true, kind: "graph-proposal", proposedKnownSet: [] }, loaded), /requires proposedGraph/);
  assert.throws(() => validateSession({ active: true, kind: "answer", html: "<p>Answer</p>", proposedKnownSet: [] }, loaded), /not valid/);
  assert.throws(() => validateSession({ active: true, kind: "quiz", type: "boundary", current: 1, question: "Why?" }, { ...loaded, topic: { graphReconciliationRequired: true } }), /blocked/);
  assert.equal(inject("x__LEARN_DATA__y", { value: "</script>" }), "x{\"value\":\"\\u003c/script>\"}y");
  console.log("LEARN renderer checks passed");
}

const args = process.argv.slice(2);
if (args[0] === "--check") {
  await check();
} else if (args.length >= 1 && args.length <= 3) {
  await render(args[0], args[1], args[2]);
} else {
  console.error("Usage: render-workspace.mjs <workspace-dir> [output-dir] [ephemeral-session.json]\n       render-workspace.mjs --check");
  process.exitCode = 1;
}
