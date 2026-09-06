#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(here, "../ui/index.html");
const idPattern = /^[a-z0-9][a-z0-9_-]*$/;
const hashPattern = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`LEARN renderer: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
}

function optionalText(value, label) {
  if (value !== undefined) requireText(value, label);
}

function requireId(value, label) {
  if (typeof value !== "string" || value.length > 64 || !idPattern.test(value)) fail(`${label} must be 1–64 lowercase letters, digits, hyphens, or underscores and start alphanumeric: ${value}`);
}

function requireDate(value, label) {
  requireText(value, label);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} must use YYYY-MM-DD: ${value}`);
}

function requireHash(value, label) {
  if (typeof value !== "string" || !hashPattern.test(value)) fail(`${label} must be a lowercase SHA-256 hash`);
}

function onlyKeys(value, allowed, label) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) fail(`${label} contains unsupported field: ${extra}`);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function requireRelativePath(value, label) {
  requireText(value, label);
  if (path.isAbsolute(value) || value.includes("\\") || path.posix.normalize(value) !== value || value === "." || value.startsWith("../")) {
    fail(`${label} must be a normalized relative path using forward slashes: ${value}`);
  }
}

async function existingPath(root, relativePath, label) {
  requireRelativePath(relativePath, label);
  const actual = await realpath(path.resolve(root, relativePath));
  if (!isWithin(root, actual)) fail(`${label} escapes its owner through a path or symlink: ${relativePath}`);
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

async function readUtf8Document(file) {
  try {
    const bytes = await readFile(file);
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), hash: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    fail(`cannot read UTF-8 file ${file}: ${error.message}`);
  }
}

async function readUtf8(file) {
  return (await readUtf8Document(file)).text;
}

async function readJsonDocument(file) {
  const { text, hash } = await readUtf8Document(file);
  try {
    return { value: JSON.parse(text), text, hash };
  } catch (error) {
    fail(`invalid JSON in ${file}: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function inspectSource(bytes, type, label) {
  const invalid = (reason) => ({ problem: `${label} ${reason}` });
  if (type === "pdf") {
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return invalid("is not a PDF file.");
  } else {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return invalid("is not valid UTF-8 text."); }
    if (!text.trim()) return invalid("is empty.");
  }
  return { hash: sha256(bytes) };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return new Set(["http:", "https:"]).has(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  return isHttpUrl(value) && new URL(value).protocol === "https:";
}

function validateMarkdown(value, label) {
  requireText(value, label);
  let prose = "";
  let fenced = false;
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!fenced && (/^\s*~~~/.test(line) || /^\s+```/.test(line))) fail(`${label} contains an unsupported code fence`);
    if (/^```/.test(line)) {
      if (fenced) {
        if (!/^```\s*$/.test(line)) { prose += "\n"; continue; }
      } else if (!/^```[a-z0-9_-]*\s*$/i.test(line)) fail(`${label} contains an unsupported code fence`);
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^\s+(?:[-+*]|\d+[.)])\s+/.test(line)) fail(`${label} cannot contain indented or nested list items`);
    if (!fenced && /^\s{0,3}(?:=+|-+)\s*$/.test(line) && index > 0 && lines[index - 1].trim() && !/^(?:```|#{1,6}\s|>\s?|\s*[-+*]\s+|\s*\d+[.)]\s+)/.test(lines[index - 1])) fail(`${label} cannot contain setext headings`);
    if (!fenced) prose += `${line.replace(/`[^`\n]*`/g, "")}\n`;
  }
  if (fenced) fail(`${label} contains an unclosed fenced code block`);
  if (/<!--|<\/?[A-Za-z][^>]*>/s.test(prose)) fail(`${label} cannot contain raw HTML`);
  if (/^#{1,2}\s|^#{5,6}\s/m.test(prose)) fail(`${label} headings must use H3 or H4`);
  if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/m.test(prose)) fail(`${label} cannot contain tables`);
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\([^\n)]*\)/g)) {
    if (match[0].startsWith("!")) fail(`${label} cannot contain images`);
    const link = match[0].match(/^\[[^\]\n]+\]\(([^)\s]+)\)$/);
    if (!link || !isHttpsUrl(link[1])) fail(`${label} links must use bare absolute HTTPS URLs without titles`);
  }
}

function localHref(outputRoot, target) {
  const relative = path.relative(outputRoot, target);
  if (!relative || path.isAbsolute(relative)) fail(`cannot create a relative source link from ${outputRoot} to ${target}`);
  return relative.split(path.sep).map((part) => part === ".." ? part : encodeURIComponent(part)).join("/");
}

function validateHashSnapshot(snapshot, referencedIds, currentHashes, label, sourceProblems = new Map()) {
  requireObject(snapshot, label);
  const expected = [...referencedIds].sort();
  const actual = Object.keys(snapshot).sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) fail(`${label} must contain exactly the referenced source IDs`);
  const staleReasons = [];
  for (const id of actual) {
    requireId(id, `${label} source ID`);
    requireHash(snapshot[id], `${label}.${id}`);
    if (sourceProblems.has(id)) staleReasons.push(sourceProblems.get(id));
    else if (!currentHashes.has(id)) staleReasons.push(`Source ${id} is no longer available.`);
    else if (currentHashes.get(id) !== snapshot[id]) staleReasons.push(`Source ${id} changed after this content was created.`);
  }
  return staleReasons;
}

function validateEvidence(items, label, evidence) {
  requireArray(items, label);
  if (!items.length) fail(`${label} must be non-empty`);
  const seen = new Set();
  for (const item of items) {
    requireObject(item, `${label} reference`);
    onlyKeys(item, ["sourceId", "locator"], `${label} reference`);
    requireId(item.sourceId, `${label} source ID`);
    requireText(item.locator, `${label} locator`);
    const key = `${item.sourceId}\u0000${item.locator}`;
    if (seen.has(key)) fail(`${label} contains duplicate evidence: ${item.sourceId} at ${item.locator}`);
    seen.add(key);
    evidence.add(item.sourceId);
  }
}

function validateSourceScopes(items, label, evidence, sourceTypes) {
  requireArray(items, label);
  if (!items.length) fail(`${label} must be non-empty`);
  const seen = new Set();
  for (const item of items) {
    requireObject(item, `${label} source`);
    onlyKeys(item, ["sourceId", "unit", "ranges"], `${label} source`);
    requireId(item.sourceId, `${label} source ID`);
    if (seen.has(item.sourceId)) fail(`${label} contains duplicate source: ${item.sourceId}`);
    seen.add(item.sourceId);
    const expectedUnit = sourceTypes.get(item.sourceId) === "pdf" ? "page" : sourceTypes.get(item.sourceId) === "text" ? "line" : null;
    if (!expectedUnit) fail(`${label} references an unregistered source: ${item.sourceId}`);
    if (item.unit !== expectedUnit) fail(`${label} for ${item.sourceId} must use ${expectedUnit} ranges`);
    requireArray(item.ranges, `${label} ranges (${item.sourceId})`);
    if (!item.ranges.length) fail(`${label} ranges (${item.sourceId}) must be non-empty`);
    let previousEnd = null;
    for (const range of item.ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every((value) => Number.isSafeInteger(value) && value > 0) || range[0] > range[1]) fail(`${label} ranges (${item.sourceId}) must be positive inclusive [start,end] integer pairs`);
      if (previousEnd !== null && range[0] <= previousEnd + 1) fail(`${label} ranges (${item.sourceId}) must be sorted, non-overlapping, and have adjacent ranges merged`);
      previousEnd = range[1];
    }
    evidence.add(item.sourceId);
  }
}

function validateGraph(graph, knownSet, currentHashes, label = "concept graph", sourceProblems = new Map(), sourceTypes = new Map(), sourceScopesRequired = false) {
  requireObject(graph, label);
  onlyKeys(graph, ["nodes", "edges", "sourceHashes"], label);
  requireArray(graph.nodes, `${label} nodes`);
  requireArray(graph.edges, `${label} edges`);
  requireArray(knownSet, `${label} known set`);
  const ids = new Set();
  const evidence = new Set();
  let missingScopes = false;
  for (const node of graph.nodes) {
    requireObject(node, `${label} concept`);
    onlyKeys(node, ["id", "label", "description", "sourceScopes", "evidence"], `${label} concept`);
    requireId(node.id, `${label} concept ID`);
    if (ids.has(node.id)) fail(`${label} concept IDs must be unique: ${node.id}`);
    ids.add(node.id);
    requireText(node.label, `${label} concept label (${node.id})`);
    requireText(node.description, `${label} concept description (${node.id})`);
    if (node.sourceScopes === undefined) {
      if (sourceScopesRequired) fail(`${label} concept sourceScopes (${node.id}) must be non-empty`);
      missingScopes = true;
    } else validateSourceScopes(node.sourceScopes, `${label} concept sourceScopes (${node.id})`, evidence, sourceTypes);
    validateEvidence(node.evidence, `${label} concept evidence (${node.id})`, evidence);
  }
  const indegree = new Map([...ids].map((id) => [id, 0]));
  const dependents = new Map([...ids].map((id) => [id, []]));
  const edgeKeys = new Set();
  for (const edge of graph.edges) {
    requireObject(edge, `${label} edge`);
    onlyKeys(edge, ["from", "to", "evidence"], `${label} edge`);
    if (!ids.has(edge.from) || !ids.has(edge.to)) fail(`${label} edge references an unknown concept: ${edge.from} -> ${edge.to}`);
    if (edge.from === edge.to) fail(`${label} concept cannot require itself: ${edge.from}`);
    const key = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(key)) fail(`${label} contains duplicate edge: ${edge.from} -> ${edge.to}`);
    edgeKeys.add(key);
    validateEvidence(edge.evidence, `${label} edge evidence (${edge.from} -> ${edge.to})`, evidence);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    dependents.get(edge.from).push(edge.to);
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
  if (visited !== ids.size) fail(`${label} contains a prerequisite cycle`);
  if (new Set(knownSet).size !== knownSet.length) fail(`${label} known set contains duplicates`);
  const known = new Set();
  for (const id of knownSet) { if (!ids.has(id)) fail(`${label} known set references an unknown concept: ${id}`); known.add(id); }
  for (const { from, to } of graph.edges) if (known.has(to) && !known.has(from)) fail(`${label} known set is not prerequisite-closed: ${to} requires ${from}`);
  const staleReasons = validateHashSnapshot(graph.sourceHashes, evidence, currentHashes, `${label} sourceHashes`, sourceProblems);
  if (missingScopes) staleReasons.push("Concept graph has concepts without structured source scopes and must be reconciled.");
  return { graph: { nodes: graph.nodes, edges: graph.edges }, staleReasons, evidence };
}

function validateCitation(citation, label) {
  requireObject(citation, label);
  requireId(citation.id, `${label} ID`);
  optionalText(citation.note, `${label} note`);
  if (citation.kind !== "source") fail(`${label} kind must be source`);
  onlyKeys(citation, ["id", "kind", "sourceId", "locator", "note"], label);
  requireId(citation.sourceId, `${label} source ID`);
  requireText(citation.locator, `${label} locator`);
}

function validateSections(sections, citations, label, purposeRequired = true) {
  requireArray(sections, `${label} sections`);
  requireArray(citations, `${label} citations`);
  const byCitation = new Map();
  for (const citation of citations) {
    validateCitation(citation, `${label} citation`);
    if (byCitation.has(citation.id)) fail(`${label} citation IDs must be unique: ${citation.id}`);
    byCitation.set(citation.id, citation);
  }
  const sectionIds = new Set();
  const usedCitations = new Set();
  const sourceIds = new Set();
  for (const section of sections) {
    requireObject(section, `${label} section`);
    onlyKeys(section, ["id", "title", "kind", "purpose", "markdown", "citationIds"], `${label} section`);
    requireId(section.id, `${label} section ID`);
    if (sectionIds.has(section.id)) fail(`${label} section IDs must be unique: ${section.id}`);
    sectionIds.add(section.id);
    requireText(section.title, `${label} section title (${section.id})`);
    if (!new Set(["source", "conflict"]).has(section.kind)) fail(`${label} section kind is invalid: ${section.kind}`);
    if (purposeRequired && section.purpose === undefined) fail(`${label} section purpose is required: ${section.id}`);
    if (section.purpose !== undefined && !new Set(["lesson", "review", "remediation", "answer"]).has(section.purpose)) fail(`${label} section purpose is invalid: ${section.purpose}`);
    validateMarkdown(section.markdown, `${label} section markdown (${section.id})`);
    requireArray(section.citationIds, `${label} section citationIds (${section.id})`);
    if (!section.citationIds.length || new Set(section.citationIds).size !== section.citationIds.length) fail(`${label} section citationIds must be non-empty and unique: ${section.id}`);
    const sectionCitations = section.citationIds.map((id) => {
      requireId(id, `${label} citation ID`);
      const citation = byCitation.get(id);
      if (!citation) fail(`${label} section references unknown citation: ${id}`);
      usedCitations.add(id);
      if (citation.kind === "source") sourceIds.add(citation.sourceId);
      return citation;
    });
    if (section.kind === "conflict" && sectionCitations.length < 2) fail(`${label} conflict section requires at least two citations: ${section.id}`);
  }
  if (citations.some(({ id }) => !usedCitations.has(id))) fail(`${label} contains an unused citation`);
  return sourceIds;
}

function validateArtifactMetadata(metadata) {
  requireObject(metadata, "artifact metadata");
  onlyKeys(metadata, ["id", "conceptId", "kind", "title", "summary", "updatedAt", "path"], "artifact metadata");
  requireId(metadata.id, "artifact ID");
  if (metadata.kind === "concept") requireId(metadata.conceptId, `artifact concept ID (${metadata.id})`);
  else if (metadata.kind === "answer" && metadata.conceptId !== null) fail(`general answer artifact conceptId must be null: ${metadata.id}`);
  else if (metadata.kind !== "answer") fail(`artifact kind must be concept or answer: ${metadata.id}`);
  requireText(metadata.title, `artifact title (${metadata.id})`);
  requireText(metadata.summary, `artifact summary (${metadata.id})`);
  requireDate(metadata.updatedAt, `artifact updatedAt (${metadata.id})`);
  requireRelativePath(metadata.path, `artifact path (${metadata.id})`);
  if (metadata.path !== `artifacts/${metadata.id}.json`) fail(`artifact path must be artifacts/${metadata.id}.json`);
}

async function loadArtifact(topicRoot, metadata, graphIds, currentHashes, sourceProblems) {
  validateArtifactMetadata(metadata);
  if (metadata.conceptId !== null && !graphIds.has(metadata.conceptId)) fail(`artifact ${metadata.id} references concept missing from the graph: ${metadata.conceptId}`);
  const file = await existingPath(topicRoot, metadata.path, `artifact path (${metadata.id})`);
  const { value: artifact } = await readJsonDocument(file);
  requireObject(artifact, `artifact ${metadata.id}`);
  onlyKeys(artifact, ["id", "conceptId", "kind", "title", "summary", "updatedAt", "sourceHashes", "sections", "citations"], `artifact ${metadata.id}`);
  for (const field of ["id", "conceptId", "kind", "title", "summary", "updatedAt"]) if (artifact[field] !== metadata[field]) fail(`artifact ${metadata.id} ${field} must match topic.json metadata`);
  if (!Array.isArray(artifact.sections) || !artifact.sections.length) fail(`artifact ${metadata.id} requires at least one section`);
  const sourceIds = validateSections(artifact.sections, artifact.citations, `artifact ${metadata.id}`);
  const staleReasons = validateHashSnapshot(artifact.sourceHashes, sourceIds, currentHashes, `artifact ${metadata.id} sourceHashes`, sourceProblems);
  return { id: artifact.id, conceptId: artifact.conceptId, kind: artifact.kind, title: artifact.title, summary: artifact.summary, updatedAt: artifact.updatedAt, stale: Boolean(staleReasons.length), staleReasons, sections: artifact.sections, citations: artifact.citations };
}

async function loadTopic(outputRoot, ref) {
  const topicRoot = ref.root;
  const [topicDoc, graphDoc, knownDoc] = await Promise.all([
    existingPath(topicRoot, "topic.json", "topic metadata path").then(readJsonDocument),
    existingPath(topicRoot, "concept_graph.json", "concept graph path").then(readJsonDocument),
    existingPath(topicRoot, "known_set.json", "known set path").then(readJsonDocument),
  ]);
  const topic = topicDoc.value;
  const knownState = knownDoc.value;
  requireObject(topic, "topic metadata");
  onlyKeys(topic, ["title", "eyebrow", "summary", "updatedAt", "graphReconciliationRequired", "sources", "artifacts"], "topic metadata");
  requireText(topic.title, "topic title");
  requireText(topic.eyebrow, "topic eyebrow");
  requireText(topic.summary, "topic summary");
  requireDate(topic.updatedAt, "topic updatedAt");
  if (typeof topic.graphReconciliationRequired !== "boolean") fail("topic graphReconciliationRequired must be boolean");
  requireArray(topic.sources, "topic sources");
  requireArray(topic.artifacts, "topic artifacts");
  requireObject(knownState, "known set");
  onlyKeys(knownState, ["conceptIds"], "known set");
  requireArray(knownState.conceptIds, "known set conceptIds");

  const sourceIds = new Set();
  const currentHashes = new Map();
  const sourceProblems = new Map();
  const sourceTypes = new Map();
  const sources = [];
  for (const source of topic.sources) {
    requireObject(source, "source metadata");
    onlyKeys(source, ["id", "title", "type", "author", "locator", "addedAt", "path"], "source metadata");
    requireId(source.id, "source ID");
    if (sourceIds.has(source.id)) fail(`source IDs must be unique: ${source.id}`);
    sourceIds.add(source.id);
    requireText(source.title, `source title (${source.id})`);
    if (!new Set(["text", "pdf"]).has(source.type)) fail(`source type must be text or pdf: ${source.id}`);
    sourceTypes.set(source.id, source.type);
    optionalText(source.author, `source author (${source.id})`);
    optionalText(source.locator, `source locator (${source.id})`);
    requireDate(source.addedAt, `source addedAt (${source.id})`);
    requireRelativePath(source.path, `source path (${source.id})`);
    const expectedPath = `sources/${source.id}.${source.type === "pdf" ? "pdf" : "txt"}`;
    if (source.path !== expectedPath) fail(`source path must be ${expectedPath}`);
    let file;
    try { file = await existingPath(topicRoot, source.path, `source path (${source.id})`); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      sourceProblems.set(source.id, `Source ${source.id} is registered but its file is missing.`);
    }
    const inspection = file ? inspectSource(await readFile(file), source.type, `Source ${source.id}`) : { problem: sourceProblems.get(source.id) };
    if (inspection.hash) currentHashes.set(source.id, inspection.hash);
    else sourceProblems.set(source.id, inspection.problem);
    sources.push({ id: source.id, title: source.title, type: source.type, author: source.author, locator: source.locator, addedAt: source.addedAt, ...(file ? { href: localHref(outputRoot, file) } : {}), ...(inspection.problem ? { integrityProblem: inspection.problem } : {}) });
  }
  const graphResult = validateGraph(graphDoc.value, knownState.conceptIds, currentHashes, "concept graph", sourceProblems, sourceTypes);
  const graphIds = new Set(graphResult.graph.nodes.map(({ id }) => id));
  const artifactIds = new Set();
  const conceptArtifacts = new Set();
  const artifacts = [];
  for (const metadata of topic.artifacts) {
    validateArtifactMetadata(metadata);
    if (artifactIds.has(metadata.id)) fail(`artifact IDs must be unique: ${metadata.id}`);
    artifactIds.add(metadata.id);
    if (metadata.conceptId !== null) {
      if (conceptArtifacts.has(metadata.conceptId)) fail(`concept has more than one artifact: ${metadata.conceptId}`);
      conceptArtifacts.add(metadata.conceptId);
    }
    artifacts.push(await loadArtifact(topicRoot, metadata, graphIds, currentHashes, sourceProblems));
  }
  const stateHashes = { topic: topicDoc.hash, conceptGraph: graphDoc.hash, knownSet: knownDoc.hash };
  const reconciliationReasons = [...new Set([...sourceProblems.values(), ...graphResult.staleReasons])];
  const graphStale = Boolean(reconciliationReasons.length);
  return {
    view: { projectId: ref.projectId, id: ref.id, name: ref.name, title: topic.title, eyebrow: topic.eyebrow, summary: topic.summary, updatedAt: topic.updatedAt, reconciliationRequired: topic.graphReconciliationRequired || graphStale, reconciliationReasons, graph: graphResult.graph, knownSet: knownState.conceptIds, sources, artifacts },
    currentHashes,
    sourceProblems,
    sourceTypes,
    stateHashes,
    graphStale,
    explicitReconciliation: topic.graphReconciliationRequired,
  };
}

function validateStateSnapshot(snapshot, current) {
  requireObject(snapshot, "session baseStateHashes");
  const keys = ["conceptGraph", "knownSet", "topic"];
  if (Object.keys(snapshot).sort().join("\u0000") !== [...keys].sort().join("\u0000")) fail("session baseStateHashes must contain exactly topic, conceptGraph, and knownSet");
  const reasons = [];
  for (const key of keys) {
    requireHash(snapshot[key], `session baseStateHashes.${key}`);
    if (snapshot[key] !== current[key]) reasons.push(`${key} state changed after this preview was created.`);
  }
  return reasons;
}

function validateSession(session, loaded, current) {
  requireObject(session, "ephemeral session payload");
  onlyKeys(session, ["active", "kind", "target", "title", "context", "baseHashes", "baseStateHashes", "sections", "citations", "proposedGraph", "proposedKnownSet"], "ephemeral session payload");
  if (session.active !== true) fail("ephemeral session payload must set active to true");
  if (!new Set(["graph-proposal", "answer"]).has(session.kind)) fail(`unknown ephemeral session kind: ${session.kind}`);
  requireObject(session.target, "session target");
  onlyKeys(session.target, ["projectId", "topicId"], "session target");
  requireId(session.target.projectId, "session target project ID");
  requireId(session.target.topicId, "session target topic ID");
  if (session.target.projectId !== current.projectId || session.target.topicId !== current.topicId) fail("session target must exactly match workspace current");
  optionalText(session.title, "session title");
  optionalText(session.context, "session context");
  const sections = session.sections === undefined ? [] : session.sections;
  const citations = session.citations === undefined ? [] : session.citations;
  const referencedSources = validateSections(sections, citations, "session", session.kind !== "graph-proposal");
  const staleReasons = validateStateSnapshot(session.baseStateHashes, loaded.stateHashes);
  let proposedGraph;
  let proposedKnownSet;
  if (session.kind === "answer") {
    if (!sections.length) fail("answer session requires sections");
    if (session.proposedGraph !== undefined || session.proposedKnownSet !== undefined) fail("answer session cannot contain proposed graph state");
  } else {
    if (!loaded.explicitReconciliation && !loaded.graphStale) fail("graph proposal requires graph reconciliation to be pending");
    if (session.proposedGraph === undefined || !Array.isArray(session.proposedKnownSet)) fail("graph proposal requires proposedGraph and proposedKnownSet");
    const result = validateGraph(session.proposedGraph, session.proposedKnownSet, loaded.currentHashes, "proposed graph", loaded.sourceProblems, loaded.sourceTypes, true);
    proposedGraph = result.graph;
    proposedKnownSet = session.proposedKnownSet;
    for (const id of result.evidence) referencedSources.add(id);
    staleReasons.push(...result.staleReasons);
    staleReasons.push(...loaded.sourceProblems.values());
  }
  staleReasons.push(...validateHashSnapshot(session.baseHashes, referencedSources, loaded.currentHashes, "session baseHashes", loaded.sourceProblems));
  return { active: true, kind: session.kind, title: session.title, context: session.context, sections, citations, proposedGraph, proposedKnownSet, stale: Boolean(staleReasons.length), staleReasons: [...new Set(staleReasons)] };
}

function inject(template, data) {
  const token = "__LEARN_DATA__";
  if (template.split(token).length !== 2) fail(`template must contain exactly one ${token} token`);
  const json = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return template.replace(token, json);
}

async function replaceDirectory(outputRoot, html) {
  const temporary = await mkdtemp(path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}-new-`));
  const previous = `${outputRoot}.previous-${process.pid}-${Date.now()}`;
  let movedPrevious = false;
  try {
    await writeFile(path.join(temporary, "index.html"), html);
    try { await rename(outputRoot, previous); movedPrevious = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, outputRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (movedPrevious) {
      try { await rename(previous, outputRoot); }
      catch (restoreError) { error.message += `; previous output remains at ${previous}: ${restoreError.message}`; }
    }
    throw error;
  }
  if (movedPrevious) await rm(previous, { recursive: true, force: true });
}

async function render(workspaceRootArg, outputRootArg, sessionPathArg, quiet = false) {
  const workspaceRoot = await realpath(path.resolve(workspaceRootArg));
  const outputRoot = await canonicalOutputPath(outputRootArg ?? path.join(workspaceRoot, "html"));
  const sessionPath = sessionPathArg ? await realpath(path.resolve(sessionPathArg)) : undefined;
  if (sessionPath) {
    if (pathsOverlap(workspaceRoot, outputRoot) || isWithin(workspaceRoot, sessionPath)) fail("ephemeral session input and output must both be outside and must not contain the durable workspace");
    if (path.basename(sessionPath) !== "session.json" || outputRoot !== path.join(path.dirname(sessionPath), "rendered")) fail("ephemeral session must use one temporary directory containing session.json and rendered/");
  } else if (outputRoot !== path.join(workspaceRoot, "html")) fail("durable output must be <workspace-root>/html");
  const workspaceFile = await existingPath(workspaceRoot, "workspace.json", "workspace metadata path");
  const [{ value: workspace }, template] = await Promise.all([readJsonDocument(workspaceFile), readUtf8(templatePath)]);
  requireObject(workspace, "workspace metadata");
  onlyKeys(workspace, ["name", "current", "projects"], "workspace metadata");
  requireText(workspace.name, "workspace name");
  requireArray(workspace.projects, "workspace projects");
  const projectIds = new Set();
  const refs = [];
  const projects = [];
  for (const project of workspace.projects) {
    requireObject(project, "project metadata");
    onlyKeys(project, ["id", "name", "topics"], "project metadata");
    requireId(project.id, "project ID");
    if (projectIds.has(project.id)) fail(`project IDs must be unique: ${project.id}`);
    projectIds.add(project.id);
    requireText(project.name, `project name (${project.id})`);
    requireArray(project.topics, `project topics (${project.id})`);
    const topicIds = new Set();
    const topics = [];
    for (const topic of project.topics) {
      requireObject(topic, `topic reference (${project.id})`);
      onlyKeys(topic, ["id", "name", "path"], `topic reference (${project.id})`);
      requireId(topic.id, "topic ID");
      if (topicIds.has(topic.id)) fail(`topic IDs must be unique in ${project.id}: ${topic.id}`);
      topicIds.add(topic.id);
      requireText(topic.name, `topic name (${project.id}/${topic.id})`);
      const root = await existingPath(workspaceRoot, topic.path, `topic path (${project.id}/${topic.id})`);
      if (pathsOverlap(root, outputRoot)) fail(`topic path overlaps disposable renderer output: ${topic.path}`);
      refs.push({ projectId: project.id, id: topic.id, name: topic.name, root });
      topics.push({ id: topic.id, name: topic.name });
    }
    projects.push({ id: project.id, name: project.name, topics });
  }
  for (let left = 0; left < refs.length; left += 1) {
    for (let right = left + 1; right < refs.length; right += 1) {
      if (pathsOverlap(refs[left].root, refs[right].root)) fail(`topic paths must not overlap: ${refs[left].id} and ${refs[right].id}`);
    }
  }
  let current = null;
  if (!Object.hasOwn(workspace, "current")) fail("workspace metadata must contain current");
  if (workspace.current !== null) {
    requireObject(workspace.current, "workspace current");
    onlyKeys(workspace.current, ["projectId", "topicId"], "workspace current");
    requireId(workspace.current.projectId, "workspace current project ID");
    requireId(workspace.current.topicId, "workspace current topic ID");
    current = { projectId: workspace.current.projectId, topicId: workspace.current.topicId };
    if (!refs.some((ref) => ref.projectId === current.projectId && ref.id === current.topicId)) fail("workspace current topic does not exist");
  }
  const loadedTopics = [];
  const internals = new Map();
  for (const ref of refs) {
    const loaded = await loadTopic(outputRoot, ref);
    loadedTopics.push(loaded.view);
    internals.set(`${ref.projectId}\u0000${ref.id}`, loaded);
  }
  let session;
  if (sessionPath) {
    if (!current) fail("ephemeral session requires a current topic");
    session = validateSession((await readJsonDocument(sessionPath)).value, internals.get(`${current.projectId}\u0000${current.topicId}`), current);
  }
  const html = inject(template, { workspace: { name: workspace.name, current, projects }, topics: loadedTopics, ...(session ? { session } : {}) });
  await replaceDirectory(outputRoot, html);
  if (!quiet) {
    console.log(`Rendered one self-contained page to ${path.join(outputRoot, "index.html")}`);
    if (session) console.log("Ephemeral session UI rendered outside the workspace; remove its temporary directory when the preview ends.");
  }
  return { outputRoot, html };
}

async function check() {
  const template = await readUtf8(templatePath);
  assert.equal(template.split("__LEARN_DATA__").length, 2);
  assert.doesNotMatch(template, /\bfetch\s*\(|type=["']module["']|localhost|127\.0\.0\.1/);
  assert.doesNotMatch(template, /\.innerHTML\s*=/);
  for (const marker of ['id="learn-data"', "function renderGraph", "renderMarkdown", "tickGraph", "requestAnimationFrame(runSimulation)", "aria-expanded"]) assert.ok(template.includes(marker));
  const inlinePatternSource = template.match(/const inlinePattern = (\/[^\n]+\/gu);/)?.[1];
  assert.ok(inlinePatternSource);
  assert.doesNotMatch("foo_bar_baz", new Function(`return ${inlinePatternSource}`)());
  assert.match("Use _emphasis_.", new Function(`return ${inlinePatternSource}`)());
  assert(pathsOverlap("/workspace/html", "/workspace/html/topic"));
  assert(!pathsOverlap("/workspace/html", "/workspace/projects/topic"));
  assert.equal(inject("x__LEARN_DATA__y", { value: "</script>\u2028" }), 'x{"value":"\\u003c/script>\\u2028"}y');
  assert.throws(() => validateMarkdown("Unsafe <script>alert(1)</script>.", "test markdown"), /raw HTML/);
  assert.throws(() => validateMarkdown("[unsafe](javascript:alert(1))", "test markdown"), /absolute HTTPS/);
  assert.throws(() => validateMarkdown("![remote](https://example.com/image.png)", "test markdown"), /images/);
  assert.throws(() => validateMarkdown("# Nested page title", "test markdown"), /H3 or H4/);
  assert.throws(() => validateMarkdown("| One | Two |\n| --- | --- |", "test markdown"), /tables/);
  assert.throws(() => validateMarkdown("```js\nunfinished", "test markdown"), /unclosed/);
  assert.throws(() => validateMarkdown("~~~js\ncode\n~~~", "test markdown"), /unsupported code fence/);
  assert.throws(() => validateMarkdown("Title\n---", "test markdown"), /setext headings/);
  assert.throws(() => validateMarkdown("Title\n  ---", "test markdown"), /setext headings/);
  assert.throws(() => validateMarkdown("- outer\n  - inner", "test markdown"), /nested list items/);
  assert.throws(() => validateMarkdown('[label](https://example.com "title")', "test markdown"), /without titles/);
  validateMarkdown("```html\n<script>example()</script>\n```", "test markdown");
  validateMarkdown("```text\n~~~ literal\n  ``` literal\n```", "test markdown");
  const tinyText = Buffer.from("Direct text source.\n");
  const pdfObjects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> >>",
  ];
  let pdf = "%PDF-1.4\n";
  const pdfOffsets = [0];
  for (const [index, body] of pdfObjects.entries()) {
    pdfOffsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${pdfObjects.length + 1}\n0000000000 65535 f \n${pdfOffsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${pdfObjects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const tinyPdf = Buffer.from(pdf);
  assert.equal(inspectSource(tinyText, "text", "Text source").hash, sha256(tinyText));
  assert.equal(inspectSource(tinyPdf, "pdf", "PDF source").hash, sha256(tinyPdf));
  assert.match(inspectSource(Buffer.from(" \n"), "text", "Text source").problem, /empty/);
  assert.match(inspectSource(Buffer.from([0xff]), "text", "Text source").problem, /UTF-8/);
  assert.match(inspectSource(Buffer.from("not a pdf"), "pdf", "PDF source").problem, /not a PDF/);
  assert.throws(() => validateCitation({ id: "web", kind: "web" }, "citation"), /kind must be source/);
  const executableScripts = [...template.matchAll(/<script(?![^>]*type=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(executableScripts.length, 1);
  new Function(executableScripts[0][1]);
  const root = await mkdtemp(path.join(tmpdir(), "learn-render-check-"));
  try {
    const workspaceRoot = path.join(root, "workspace");
    const topicRoot = path.join(workspaceRoot, "projects", "p", "topics", "t");
    const sourceBody = "Direct source text that must not be embedded.\n";
    const sourceBytes = Buffer.from(sourceBody);
    const sourceHash = sha256(sourceBytes);
    const pdfBytes = tinyPdf;
    const graph = { nodes: [{ id: "basics", label: "Basics", description: "The foundation.", sourceScopes: [{ sourceId: "source", unit: "line", ranges: [[1, 1]] }], evidence: [{ sourceId: "source", locator: "Line 1" }] }], edges: [], sourceHashes: { source: sourceHash } };
    const graphInputs = [[], new Map([["source", sourceHash]]), "test graph", new Map(), new Map([["source", "text"]])];
    assert.throws(() => validateGraph({ ...graph, nodes: [{ ...graph.nodes[0], sourceScopes: [{ sourceId: "source", unit: "page", ranges: [[1, 1]] }] }] }, ...graphInputs, true), /must use line ranges/);
    assert.match(validateGraph({ ...graph, nodes: [{ ...graph.nodes[0], sourceScopes: undefined }] }, ...graphInputs).staleReasons[0], /must be reconciled/);
    const known = { conceptIds: [] };
    const topic = { title: "Topic", eyebrow: "Test", summary: "Integration fixture.", updatedAt: "2026-09-05", graphReconciliationRequired: false, sources: [{ id: "source", title: "Text source", type: "text", addedAt: "2026-09-05", path: "sources/source.txt" }, { id: "paper", title: "PDF source", type: "pdf", addedAt: "2026-09-05", path: "sources/paper.pdf" }], artifacts: [{ id: "basics", conceptId: "basics", kind: "concept", title: "Basics", summary: "A safe lesson.", updatedAt: "2026-09-05", path: "artifacts/basics.json" }] };
    const artifact = { id: "basics", conceptId: "basics", kind: "concept", title: "Basics", summary: "A safe lesson.", updatedAt: "2026-09-05", sourceHashes: { source: sourceHash }, sections: [{ id: "lesson", title: "Lesson", kind: "source", purpose: "lesson", markdown: "Safe text with a [reference](https://example.com).", citationIds: ["source-one"] }], citations: [{ id: "source-one", kind: "source", sourceId: "source", locator: "Line 1" }] };
    await mkdir(path.join(topicRoot, "sources"), { recursive: true });
    await mkdir(path.join(topicRoot, "artifacts"), { recursive: true });
    const topicText = JSON.stringify(topic), graphText = JSON.stringify(graph), knownText = JSON.stringify(known);
    await writeFile(path.join(workspaceRoot, "workspace.json"), JSON.stringify({ name: "Workspace", current: { projectId: "p", topicId: "t" }, projects: [{ id: "p", name: "Project", topics: [{ id: "t", name: "Topic", path: "projects/p/topics/t" }] }] }));
    await writeFile(path.join(topicRoot, "topic.json"), topicText);
    await writeFile(path.join(topicRoot, "concept_graph.json"), graphText);
    await writeFile(path.join(topicRoot, "known_set.json"), knownText);
    const sourceFile = path.join(topicRoot, "sources", "source.txt");
    const pdfFile = path.join(topicRoot, "sources", "paper.pdf");
    await writeFile(sourceFile, sourceBytes);
    await writeFile(pdfFile, pdfBytes);
    await writeFile(path.join(topicRoot, "artifacts", "basics.json"), JSON.stringify(artifact));
    const { outputRoot, html } = await render(workspaceRoot, undefined, undefined, true);
    assert.deepEqual(await readdir(outputRoot), ["index.html"]);
    assert(!html.includes(sourceBody.trim()));
    assert(!html.includes("<script>alert(1)</script>"));
    const match = html.match(/<script type="application\/json" id="learn-data">([\s\S]*?)<\/script>/);
    assert(match);
    const payload = JSON.parse(match[1]);
    assert.equal(payload.topics.length, 1);
    assert.equal(payload.topics[0].artifacts[0].stale, false);
    assert.equal(payload.topics[0].sources.length, 2);
    assert.deepEqual(payload.topics[0].graph.nodes[0].sourceScopes[0].ranges, [[1, 1]]);
    assert.match(payload.topics[0].sources[0].href, /^\.\.\//);
    assert.equal(fileURLToPath(new URL(payload.topics[0].sources[0].href, pathToFileURL(path.join(outputRoot, "index.html")))), await realpath(sourceFile));
    assert.equal(fileURLToPath(new URL(payload.topics[0].sources[1].href, pathToFileURL(path.join(outputRoot, "index.html")))), await realpath(pdfFile));
    await writeFile(path.join(topicRoot, "topic.json"), JSON.stringify({ ...topic, sources: [{ ...topic.sources[0], type: "url" }] }));
    await assert.rejects(render(workspaceRoot, undefined, undefined, true), /source type must be text or pdf/);
    await writeFile(path.join(topicRoot, "topic.json"), topicText);
    await writeFile(sourceFile, Buffer.concat([sourceBytes, Buffer.from("changed\n")]));
    const changed = await render(workspaceRoot, undefined, undefined, true);
    assert.equal(JSON.parse(changed.html.match(/id="learn-data">([\s\S]*?)<\/script>/)[1]).topics[0].artifacts[0].stale, true);
    await writeFile(sourceFile, sourceBytes);
    await rm(sourceFile);
    const missing = await render(workspaceRoot, undefined, undefined, true);
    const missingPayload = JSON.parse(missing.html.match(/id="learn-data">([\s\S]*?)<\/script>/)[1]);
    assert.match(missingPayload.topics[0].sources[0].integrityProblem, /missing/);
    assert.equal(missingPayload.topics[0].reconciliationRequired, true);
    assert.equal(missingPayload.topics[0].artifacts[0].stale, true);
    await writeFile(sourceFile, sourceBytes);
    await render(workspaceRoot, undefined, undefined, true);
    const renderedBeforeRejectedInputs = await readFile(path.join(outputRoot, "index.html"));
    const nestedRoot = path.join(topicRoot, "nested");
    await mkdir(nestedRoot);
    await writeFile(path.join(workspaceRoot, "workspace.json"), JSON.stringify({ name: "Workspace", current: { projectId: "p", topicId: "t" }, projects: [{ id: "p", name: "Project", topics: [{ id: "t", name: "Topic", path: "projects/p/topics/t" }, { id: "nested", name: "Nested", path: "projects/p/topics/t/nested" }] }] }));
    await assert.rejects(render(workspaceRoot, undefined, undefined, true), /topic paths must not overlap/);
    assert.deepEqual(await readFile(path.join(outputRoot, "index.html")), renderedBeforeRejectedInputs);
    await writeFile(path.join(workspaceRoot, "workspace.json"), JSON.stringify({ name: "Workspace", current: { projectId: "p", topicId: "t" }, projects: [{ id: "p", name: "Project", topics: [{ id: "t", name: "Topic", path: "html" }] }] }));
    await assert.rejects(render(workspaceRoot, undefined, undefined, true), /topic path overlaps disposable renderer output/);
    assert.deepEqual(await readFile(path.join(outputRoot, "index.html")), renderedBeforeRejectedInputs);
    await mkdir(path.join(root, "outside"));
    await writeFile(path.join(workspaceRoot, "workspace.json"), JSON.stringify({ name: "Workspace", current: { projectId: "p", topicId: "t" }, projects: [{ id: "p", name: "Project", topics: [{ id: "t", name: "Topic", path: "../outside" }] }] }));
    await assert.rejects(render(workspaceRoot, undefined, undefined, true), /must be a normalized relative path/);
    assert.deepEqual(await readFile(path.join(outputRoot, "index.html")), renderedBeforeRejectedInputs);
    await writeFile(path.join(workspaceRoot, "workspace.json"), JSON.stringify({ name: "Workspace", current: { projectId: "p", topicId: "t" }, projects: [{ id: "p", name: "Project", topics: [{ id: "t", name: "Topic", path: "projects/p/topics/t" }] }] }));
    const previewRoot = path.join(root, "preview");
    const sessionPath = path.join(previewRoot, "session.json");
    await mkdir(previewRoot);
    const session = { active: true, kind: "answer", target: { projectId: "p", topicId: "t" }, title: "Safe preview", baseHashes: { source: sourceHash }, baseStateHashes: { topic: sha256(topicText), conceptGraph: sha256(graphText), knownSet: sha256(knownText) }, sections: [{ id: "answer", title: "Answer", kind: "source", purpose: "answer", markdown: "A current answer.", citationIds: ["source-one"] }], citations: [{ id: "source-one", kind: "source", sourceId: "source", locator: "Line 1" }] };
    await writeFile(sessionPath, JSON.stringify({ ...session, target: { projectId: "p", topicId: "wrong" } }));
    await assert.rejects(render(workspaceRoot, path.join(previewRoot, "rendered"), sessionPath, true), /session target must exactly match workspace current/);
    await writeFile(sessionPath, JSON.stringify(session));
    const preview = await render(workspaceRoot, path.join(previewRoot, "rendered"), sessionPath, true);
    assert.equal(JSON.parse(preview.html.match(/id="learn-data">([\s\S]*?)<\/script>/)[1]).session.stale, false);
    session.baseStateHashes.knownSet = "0".repeat(64);
    await writeFile(sessionPath, JSON.stringify(session));
    const stalePreview = await render(workspaceRoot, path.join(previewRoot, "rendered"), sessionPath, true);
    assert.equal(JSON.parse(stalePreview.html.match(/id="learn-data">([\s\S]*?)<\/script>/)[1]).session.stale, true);
    const reconcilingTopicText = JSON.stringify({ ...topic, graphReconciliationRequired: true });
    await writeFile(path.join(topicRoot, "topic.json"), reconcilingTopicText);
    const graphSession = { active: true, kind: "graph-proposal", target: { projectId: "p", topicId: "t" }, baseHashes: { source: sourceHash }, baseStateHashes: { topic: sha256(reconcilingTopicText), conceptGraph: sha256(graphText), knownSet: sha256(knownText) }, sections: [{ id: "proposal", title: "Proposal", kind: "source", markdown: "A grounded graph proposal.", citationIds: ["source-one"] }], citations: [{ id: "source-one", kind: "source", sourceId: "source", locator: "Line 1" }], proposedGraph: graph, proposedKnownSet: [] };
    await writeFile(sessionPath, JSON.stringify(graphSession));
    const graphPreview = await render(workspaceRoot, path.join(previewRoot, "rendered"), sessionPath, true);
    const graphPayload = JSON.parse(graphPreview.html.match(/id="learn-data">([\s\S]*?)<\/script>/)[1]);
    assert.equal(graphPayload.session.stale, false);
    assert.equal(graphPayload.session.proposedGraph.nodes[0].evidence[0].locator, "Line 1");
    const emptyRoot = path.join(root, "empty");
    await mkdir(emptyRoot);
    await writeFile(path.join(emptyRoot, "workspace.json"), JSON.stringify({ name: "Empty", current: null, projects: [] }));
    const empty = await render(emptyRoot, undefined, undefined, true);
    assert.deepEqual(JSON.parse(empty.html.match(/id="learn-data">([\s\S]*?)<\/script>/)[1]).topics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("LEARN renderer checks passed");
}

const args = process.argv.slice(2);
if (args[0] === "--check") await check();
else if (args.length >= 1 && args.length <= 3) await render(args[0], args[1], args[2]);
else {
  console.error("Usage: render-workspace.mjs <workspace-dir> [output-dir] [ephemeral-session.json]\n       render-workspace.mjs --check");
  process.exitCode = 1;
}
