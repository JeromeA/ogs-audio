// ==UserScript==
// @name         OGS Blind Audio
// @namespace    https://online-go.com/
// @version      0.1.17
// @description  Speak opponent moves and hovered board coordinates on OGS.
// @match        https://online-go.com/*
// @match        https://beta.online-go.com/*
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const HOVER_SETTLE_MS = 100;
  const MAX_BOARD_SIZE = 25;
  const BOARD_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
  const LOCAL_MOVE_MEMORY_MS = 2500;
  const PREVIEW_MEMORY_MS = 5000;
  const MOVE_DEDUPE_MS = 1500;
  const LOG_PREFIX = '[ogs-audio]';
  const DEBUG_LOGGING = true;
  const GOBAN_SCAN_INTERVAL_MS = 1000;
  const SCRIPT_VERSION = '0.1.17';

  let boardSize = null;
  let lastHoverAnnouncement = null;
  let pendingHoverAnnouncement = null;
  let hoverTimerId = null;
  let activeHoverUtterance = null;
  let activeHoverAnnouncement = null;
  const recentLocalMoves = [];
  const recentPreviews = new Map();
  const recentMoveDetections = [];
  let gobanScanTimerId = null;
  let installedGobanInstrumentation = false;
  const instrumentedObjects = new WeakSet();
  const observedBoardRoots = new WeakSet();
  let loggedMissingGobanCandidate = false;

  function log(message, details) {
    if (!DEBUG_LOGGING) {
      return;
    }

    if (details === undefined) {
      console.log(LOG_PREFIX, message);
      return;
    }

    console.log(LOG_PREFIX, message, details);
  }

  function logFunction(name, details) {
    void name;
    void details;
  }

  function summarizeValue(value) {
    if (value == null) {
      return value;
    }

    if (typeof value === 'string') {
      return value.length > 160 ? `${value.slice(0, 160)}...` : value;
    }

    if (Array.isArray(value)) {
      return {
        type: 'array',
        length: value.length
      };
    }

    if (typeof value === 'object') {
      return {
        type: 'object',
        keys: Object.keys(value).slice(0, 12)
      };
    }

    return value;
  }

  function summarizeMoveNode(node) {
    if (!node || typeof node !== 'object') {
      return summarizeValue(node);
    }

    return {
      move_number: node.move_number,
      x: node.x,
      y: node.y,
      player: node.player,
      text: typeof node.text === 'string' ? summarizeValue(node.text) : undefined
    };
  }

  function parseNumericOpacity(value) {
    if (value == null || value === '') {
      return 1;
    }

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 1;
  }

  function parseTranslate(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const match = value.match(/translate\(\s*([-\d.]+)(?:[,\s]+([-\d.]+))?\s*\)/i);
    if (!match) {
      return null;
    }

    const x = Number.parseFloat(match[1]);
    const y = Number.parseFloat(match[2] ?? '0');
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return { x, y };
  }

  function formatPointKey(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    const roundedX = Math.round(x * 1000) / 1000;
    const roundedY = Math.round(y * 1000) / 1000;
    return `${roundedX},${roundedY}`;
  }

  function parseStoneColorFromHref(href) {
    if (typeof href !== 'string') {
      return 'unknown';
    }

    const lower = href.toLowerCase();
    if (lower.includes('white')) {
      return 'white';
    }

    if (lower.includes('black')) {
      return 'black';
    }

    return 'unknown';
  }

  function getBoardPointFromGraphicsElement(node) {
    if (!(node instanceof SVGGraphicsElement)) {
      return null;
    }

    try {
      const bbox = node.getBBox();
      const matrix = node.getCTM();
      if (!bbox || !matrix) {
        return null;
      }

      const centerX = bbox.x + bbox.width / 2;
      const centerY = bbox.y + bbox.height / 2;
      return {
        x: matrix.a * centerX + matrix.c * centerY + matrix.e,
        y: matrix.b * centerX + matrix.d * centerY + matrix.f
      };
    } catch (error) {
      return null;
    }
  }

  function getTranslateFromNode(node) {
    let current = node instanceof Element ? node : null;
    while (current) {
      const parsed = parseTranslate(current.getAttribute('transform'));
      if (parsed) {
        return parsed;
      }

      if (current instanceof SVGSVGElement) {
        return null;
      }

      const parent = current.parentNode;
      current = parent instanceof Element ? parent : null;
    }

    return null;
  }

  function extractNodePoint(node) {
    return getBoardPointFromGraphicsElement(node) || getTranslateFromNode(node);
  }

  function speak(text) {
    if (typeof speechSynthesis === 'undefined' || !text) {
      return;
    }

    const msg = new SpeechSynthesisUtterance(text);
    speechSynthesis.speak(msg);
  }

  function speakHoverAnnouncement(message) {
    if (typeof speechSynthesis === 'undefined' || !message) {
      return;
    }

    const msg = new SpeechSynthesisUtterance(message);
    activeHoverUtterance = msg;
    activeHoverAnnouncement = message;
    msg.addEventListener('end', () => {
      if (activeHoverUtterance === msg) {
        activeHoverUtterance = null;
        activeHoverAnnouncement = null;
      }
    });
    msg.addEventListener('error', () => {
      if (activeHoverUtterance === msg) {
        activeHoverUtterance = null;
        activeHoverAnnouncement = null;
      }
    });
    speechSynthesis.speak(msg);
  }

  function cancelHoverUtteranceIfLeaving(message) {
    if (
      typeof speechSynthesis === 'undefined' ||
      !activeHoverUtterance ||
      !activeHoverAnnouncement ||
      activeHoverAnnouncement === message
    ) {
      return;
    }

    speechSynthesis.cancel();
    activeHoverUtterance = null;
    activeHoverAnnouncement = null;
  }

  function clearPendingHoverAnnouncement() {
    pendingHoverAnnouncement = null;

    if (hoverTimerId !== null) {
      clearTimeout(hoverTimerId);
      hoverTimerId = null;
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function toCoordinate(row, col, size) {
    const letter = BOARD_LETTERS[col];
    if (!letter || size < 2 || size > MAX_BOARD_SIZE) {
      return null;
    }

    return `${letter}${size - row}`;
  }

  function decodeSgfPoint(point) {
    if (typeof point !== 'string') {
      return null;
    }

    if (point === '' || point === '..' || point.toLowerCase() === 'pass') {
      return 'pass';
    }

    if (!/^[a-z]{2}$/i.test(point)) {
      return null;
    }

    const normalized = point.toLowerCase();
    const col = normalized.charCodeAt(0) - 97;
    const row = normalized.charCodeAt(1) - 97;
    const size = getBoardSize();

    if (col < 0 || row < 0 || col >= size || row >= size) {
      return null;
    }

    return toCoordinate(row, col, size);
  }

  function normalizeCoordinate(value) {
    if (value == null) {
      return null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      if (trimmed.toLowerCase() === 'pass') {
        return 'pass';
      }

      if (/^[A-Z][0-9]+$/i.test(trimmed)) {
        return trimmed.toUpperCase();
      }

      return decodeSgfPoint(trimmed);
    }

    return null;
  }

  function coordinateFromXY(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return null;
    }

    const size = getBoardSize();
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return null;
    }

    return toCoordinate(y, x, size);
  }

  function rememberLocalMove(coordinate) {
    if (!coordinate) {
      return;
    }

    log('rememberLocalMove', { coordinate });
    const now = Date.now();
    recentLocalMoves.push({ coordinate, at: now });
    pruneRecentLocalMoves(now);
  }

  function pruneRecentLocalMoves(now = Date.now()) {
    while (recentLocalMoves.length > 0 && now - recentLocalMoves[0].at > LOCAL_MOVE_MEMORY_MS) {
      recentLocalMoves.shift();
    }
  }

  function prunePreviews(now = Date.now()) {
    for (const [key, entry] of recentPreviews.entries()) {
      if (now - entry.at > PREVIEW_MEMORY_MS) {
        recentPreviews.delete(key);
      }
    }
  }

  function rememberPreview(entry) {
    if (!entry?.key) {
      return;
    }

    const now = Date.now();
    recentPreviews.set(entry.key, {
      at: now,
      color: entry.color,
      x: entry.x,
      y: entry.y
    });
    prunePreviews(now);
  }

  function wasRecentPreview(key, color = null) {
    prunePreviews();
    const entry = recentPreviews.get(key);
    if (!entry) {
      return false;
    }

    return color == null || entry.color === color;
  }

  function pruneRecentMoveDetections(now = Date.now()) {
    while (
      recentMoveDetections.length > 0 &&
      now - recentMoveDetections[0].at > MOVE_DEDUPE_MS
    ) {
      recentMoveDetections.shift();
    }
  }

  function recentlyDetectedMove(moveKey) {
    pruneRecentMoveDetections();
    return recentMoveDetections.some((entry) => entry.moveKey === moveKey);
  }

  function rememberDetectedMove(moveKey) {
    const now = Date.now();
    recentMoveDetections.push({ moveKey, at: now });
    pruneRecentMoveDetections(now);
  }

  function describeDetectedMove(move) {
    return {
      source: move.source,
      color: move.color,
      coordinate: move.coordinate,
      translate: move.translate,
      reason: move.reason,
      evidence: move.evidence
    };
  }

  function announceDetectedMove(move) {
    if (!move?.coordinate) {
      return;
    }

    const moveKey = `${move.source}:${move.color}:${move.coordinate}`;
    if (recentlyDetectedMove(moveKey)) {
      log('move deduped', describeDetectedMove(move));
      return;
    }

    rememberDetectedMove(moveKey);
    rememberLocalMove(move.coordinate);
    log('move detected', describeDetectedMove(move));

    const colorWord = move.color === 'unknown'
      ? 'Stone'
      : `${move.color[0].toUpperCase()}${move.color.slice(1)}`;
    if (move.coordinate === 'pass') {
      speak(`${colorWord} passes`);
      return;
    }

    speak(`${colorWord} plays ${move.coordinate}`);
  }

  function maybeAnnounceHover(message) {
    if (!message) {
      clearPendingHoverAnnouncement();
      return;
    }

    if (lastHoverAnnouncement === message || pendingHoverAnnouncement === message) {
      return;
    }

    clearPendingHoverAnnouncement();
    pendingHoverAnnouncement = message;
    hoverTimerId = window.setTimeout(() => {
      if (pendingHoverAnnouncement !== message) {
        return;
      }

      lastHoverAnnouncement = message;
      pendingHoverAnnouncement = null;
      hoverTimerId = null;
      speakHoverAnnouncement(message);
    }, HOVER_SETTLE_MS);
  }

  function isVisibleSquare(rect) {
    if (rect.width < 160 || rect.height < 160) {
      return false;
    }

    const ratio = rect.width / rect.height;
    return ratio > 0.85 && ratio < 1.15;
  }

  function scoreBoardCandidate(element, rect) {
    let score = 0;
    const lowerClass = String(element.className || '').toLowerCase();
    const lowerId = String(element.id || '').toLowerCase();
    const lowerRole = String(element.getAttribute?.('role') || '').toLowerCase();

    if (lowerClass.includes('goban') || lowerClass.includes('board')) {
      score += 200000;
    }

    if (lowerId.includes('goban') || lowerId.includes('board')) {
      score += 100000;
    }

    if (lowerRole.includes('grid') || lowerRole.includes('application')) {
      score += 25000;
    }

    if (element.closest('[id="main-content"]')) {
      score += 50000;
    }

    if (element.tagName === 'CANVAS' || element.tagName === 'SVG') {
      score += 10000;
    }

    score -= rect.width * rect.height / 20;

    return score;
  }

  function describeBoardCandidate(element) {
    if (!element) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName,
      id: element.id || null,
      className: String(element.className || ''),
      role: element.getAttribute?.('role') || null,
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function pushBoardCandidate(list, element, reason) {
    if (!(element instanceof Element)) {
      return;
    }

    list.push({ element, reason });
  }

  function collectAncestorCandidates(start, list, reasonPrefix) {
    let node = start instanceof Element ? start : null;
    let depth = 0;

    while (node && depth < 8) {
      pushBoardCandidate(list, node, `${reasonPrefix}-self-${depth}`);
      if (node instanceof HTMLElement) {
        pushBoardCandidate(list, node.querySelector('canvas'), `${reasonPrefix}-canvas-${depth}`);
        pushBoardCandidate(list, node.querySelector('svg'), `${reasonPrefix}-svg-${depth}`);
        pushBoardCandidate(list, node.querySelector('[class*="goban"]'), `${reasonPrefix}-goban-${depth}`);
        pushBoardCandidate(list, node.querySelector('[class*="board"]'), `${reasonPrefix}-board-${depth}`);
      }
      node = node.parentElement;
      depth += 1;
    }
  }

  function getReasonBonus(reason) {
    if (reason.startsWith('pointer-target-self-')) {
      return 120000;
    }

    if (reason.startsWith('pointer-target-')) {
      return 90000;
    }

    if (reason.startsWith('elementsFromPoint-')) {
      return 70000;
    }

    return 0;
  }

  function findBoardSurface(clientX, clientY, pointerTarget) {
    const rawCandidates = [];
    collectAncestorCandidates(pointerTarget, rawCandidates, 'pointer-target');

    if (Number.isFinite(clientX) && Number.isFinite(clientY) && typeof document.elementsFromPoint === 'function') {
      const stack = document.elementsFromPoint(clientX, clientY);
      for (let index = 0; index < stack.length; index += 1) {
        collectAncestorCandidates(stack[index], rawCandidates, `elementsFromPoint-${index}`);
      }
    }

    const selectorCandidates = document.querySelectorAll(
      '[class*="goban"], [id*="goban"], [class*="board"], [id*="board"], canvas, svg'
    );
    for (const candidate of selectorCandidates) {
      pushBoardCandidate(rawCandidates, candidate, 'selector');
    }

    let best = null;
    let bestScore = -1;
    const seen = new Set();
    const scoredCandidates = [];

    for (const entry of rawCandidates) {
      const candidate = entry.element;
      if (!(candidate instanceof Element)) {
        continue;
      }

      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);

      const rect = candidate.getBoundingClientRect();
      if (!isVisibleSquare(rect)) {
        continue;
      }

      const style = window.getComputedStyle(candidate);
      if (style.visibility === 'hidden' || style.display === 'none') {
        continue;
      }

      const score = scoreBoardCandidate(candidate, rect) + getReasonBonus(entry.reason);
      scoredCandidates.push({
        reason: entry.reason,
        score,
        ...describeBoardCandidate(candidate)
      });
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  function getSvgClassName(svg) {
    if (!(svg instanceof SVGSVGElement)) {
      return '';
    }

    const className = svg.className;
    if (typeof className === 'string') {
      return className;
    }

    if (className && typeof className.baseVal === 'string') {
      return className.baseVal;
    }

    return '';
  }

  function describeShadowHost(host, reason) {
    const rect = host.getBoundingClientRect();
    return {
      reason,
      tagName: host.tagName,
      id: host.id || null,
      className: String(host.className || ''),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      hasShadowRoot: Boolean(host.shadowRoot),
      gameId: host.getAttribute('data-game-id')
    };
  }

  function pushShadowHostCandidate(source, list, reason) {
    if (!(source instanceof Element)) {
      return;
    }

    const gobanHost = source.matches?.('.Goban[data-pointers-bound="true"]')
      ? source
      : source.closest?.('.Goban[data-pointers-bound="true"]');
    if (gobanHost instanceof HTMLElement) {
      list.push({ host: gobanHost, reason });
    }
  }

  function getShadowRootBoardSvg(host) {
    if (!(host instanceof HTMLElement) || !host.shadowRoot) {
      return null;
    }

    const directSvg = host.shadowRoot.querySelector('svg');
    if (directSvg instanceof SVGSVGElement) {
      return directSvg;
    }

    return null;
  }

  function installBoardMutationObserver(host) {
    if (!(host instanceof HTMLElement) || !host.shadowRoot || observedBoardRoots.has(host.shadowRoot)) {
      return;
    }

    observedBoardRoots.add(host.shadowRoot);
    const observer = new MutationObserver((records) => {
      handleBoardMutationBatch(host, records);
    });

    observer.observe(host.shadowRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href', 'x', 'y', 'transform', 'class', 'opacity', 'fill', 'stroke']
    });

    log(
      `installBoardMutationObserver gameId=${host.getAttribute('data-game-id') || 'unknown'} ` +
      `class=${String(host.className || '')}`
    );
  }

  function collectBoardSvgCandidates(source, list, reason) {
    if (!(source instanceof Element)) {
      return;
    }

    if (source instanceof SVGSVGElement) {
      list.push({ svg: source, reason: `${reason}-self` });
    }

    const shadowHostCandidates = [];
    pushShadowHostCandidate(source, shadowHostCandidates, reason);
    for (const entry of shadowHostCandidates) {
      const shadowSvg = getShadowRootBoardSvg(entry.host);
      if (shadowSvg) {
        list.push({ svg: shadowSvg, reason: `${entry.reason}-shadow-root` });
      }
    }
  }

  function describeSvgCandidate(svg, reason) {
    const rect = svg.getBoundingClientRect();
    return {
      reason,
      id: svg.id || null,
      className: getSvgClassName(svg),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      area: Math.round(rect.width * rect.height),
      viewBox: svg.getAttribute('viewBox') || null
    };
  }

  function getPointerBoardSvg(pointerTarget, clientX, clientY, boardSurface) {
    const rawHosts = [];
    pushShadowHostCandidate(pointerTarget, rawHosts, 'pointer-target');

    if (Number.isFinite(clientX) && Number.isFinite(clientY) && typeof document.elementsFromPoint === 'function') {
      const stack = document.elementsFromPoint(clientX, clientY);
      for (let index = 0; index < stack.length; index += 1) {
        pushShadowHostCandidate(stack[index], rawHosts, `elementsFromPoint-${index}`);
      }
    }

    pushShadowHostCandidate(boardSurface, rawHosts, 'board-surface');

    const seenHosts = new Set();
    const describedHosts = [];
    for (const entry of rawHosts) {
      const host = entry.host;
      if (!(host instanceof HTMLElement) || seenHosts.has(host)) {
        continue;
      }
      seenHosts.add(host);
      describedHosts.push(describeShadowHost(host, entry.reason));
    }

    const rawCandidates = [];
    collectBoardSvgCandidates(pointerTarget, rawCandidates, 'pointer-target');

    if (Number.isFinite(clientX) && Number.isFinite(clientY) && typeof document.elementsFromPoint === 'function') {
      const stack = document.elementsFromPoint(clientX, clientY);
      for (let index = 0; index < stack.length; index += 1) {
        collectBoardSvgCandidates(stack[index], rawCandidates, `elementsFromPoint-${index}`);
      }
    }

    collectBoardSvgCandidates(boardSurface, rawCandidates, 'board-surface');

    const seen = new Set();
    const described = [];
    let bestSvg = null;
    let bestArea = -1;

    for (const entry of rawCandidates) {
      const svg = entry.svg;
      if (!(svg instanceof SVGSVGElement) || seen.has(svg)) {
        continue;
      }
      seen.add(svg);

      const rect = svg.getBoundingClientRect();
      const area = rect.width * rect.height;
      described.push(describeSvgCandidate(svg, entry.reason));
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      if (area > bestArea) {
        bestArea = area;
        bestSvg = svg;
      }
    }

    return bestSvg;
  }

  function getSvgCoordinateSpace(svg) {
    const viewBox = svg.viewBox && svg.viewBox.baseVal;
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      return {
        x: viewBox.x,
        y: viewBox.y,
        width: viewBox.width,
        height: viewBox.height
      };
    }

    const width = Number.parseFloat(svg.getAttribute('width') || '');
    const height = Number.parseFloat(svg.getAttribute('height') || '');
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return {
        x: 0,
        y: 0,
        width,
        height
      };
    }

    return null;
  }

  function parseGridSegmentsFromPathData(pathData) {
    if (typeof pathData !== 'string' || pathData.length === 0) {
      return [];
    }

    const segments = [];
    const pattern = /M\s*([-\d.]+)\s+([-\d.]+)\s+L\s*([-\d.]+)\s+([-\d.]+)/g;
    let match = null;

    while ((match = pattern.exec(pathData)) !== null) {
      segments.push({
        x1: Number.parseFloat(match[1]),
        y1: Number.parseFloat(match[2]),
        x2: Number.parseFloat(match[3]),
        y2: Number.parseFloat(match[4])
      });
    }

    return segments.filter((segment) => (
      Number.isFinite(segment.x1) &&
      Number.isFinite(segment.y1) &&
      Number.isFinite(segment.x2) &&
      Number.isFinite(segment.y2)
    ));
  }

  function uniqueSorted(values) {
    return [...new Set(values.map((value) => Math.round(value * 1000) / 1000))].sort((left, right) => left - right);
  }

  function averageStep(values) {
    if (!Array.isArray(values) || values.length < 2) {
      return null;
    }

    let total = 0;
    for (let index = 1; index < values.length; index += 1) {
      total += values[index] - values[index - 1];
    }

    return total / (values.length - 1);
  }

  function maxDeviation(values, average) {
    if (!Array.isArray(values) || values.length < 2 || !Number.isFinite(average) || average <= 0) {
      return Infinity;
    }

    let deviation = 0;
    for (let index = 1; index < values.length; index += 1) {
      const step = values[index] - values[index - 1];
      deviation = Math.max(deviation, Math.abs(step - average));
    }

    return deviation;
  }

  function parseGridMetricsFromSvg(svg) {
    const coordinateSpace = getSvgCoordinateSpace(svg);
    if (!coordinateSpace) {
      return null;
    }

    let bestMetrics = null;
    let bestScore = -1;
    const paths = svg.querySelectorAll('path');
    for (const path of paths) {
      const pathData = path.getAttribute('d') || '';
      const segments = parseGridSegmentsFromPathData(pathData);
      if (segments.length < 4) {
        continue;
      }

      const verticals = uniqueSorted(
        segments
          .filter((segment) => Math.abs(segment.x1 - segment.x2) < 0.001)
          .map((segment) => segment.x1)
      );
      const horizontals = uniqueSorted(
        segments
          .filter((segment) => Math.abs(segment.y1 - segment.y2) < 0.001)
          .map((segment) => segment.y1)
      );

      if (verticals.length < 2 || horizontals.length < 2 || verticals.length !== horizontals.length) {
        continue;
      }

      const xStep = averageStep(verticals);
      const yStep = averageStep(horizontals);
      if (!xStep || !yStep) {
        continue;
      }

      const xDeviation = maxDeviation(verticals, xStep);
      const yDeviation = maxDeviation(horizontals, yStep);
      const isUniform = xDeviation <= xStep * 0.05 && yDeviation <= yStep * 0.05;
      if (!isUniform) {
        continue;
      }

      const stroke = String(path.getAttribute('stroke') || '').toLowerCase();
      const strokeWidth = Number.parseFloat(String(path.getAttribute('stroke-width') || '0').replace('px', ''));
      const segmentLength = Math.abs(verticals[verticals.length - 1] - verticals[0]) +
        Math.abs(horizontals[horizontals.length - 1] - horizontals[0]);
      let score = verticals.length * 1000 + horizontals.length * 1000 + segmentLength;
      if (stroke && stroke !== 'none') {
        score += 5000;
      }
      if (Number.isFinite(strokeWidth) && strokeWidth > 0) {
        score += 1000;
      }

      if (score <= bestScore) {
        continue;
      }

      bestScore = score;
      bestMetrics = {
        boardSize: verticals.length,
        left: verticals[0],
        right: verticals[verticals.length - 1],
        top: horizontals[0],
        bottom: horizontals[horizontals.length - 1],
        xStep,
        yStep,
        xDeviation,
        yDeviation,
        verticals,
        horizontals,
        coordinateSpace
      };
    }

    if (!bestMetrics) {
      return null;
    }

    return bestMetrics;
  }

  function nearestIndex(values, target) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < values.length; index += 1) {
      const distance = Math.abs(values[index] - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  function setBoardSize(value) {
    if (!Number.isInteger(value) || value < 2 || value > MAX_BOARD_SIZE) {
      return;
    }

    boardSize = value;
  }

  function getBoardSize() {
    if (boardSize) {
      return boardSize;
    }

    const text = document.body?.innerText || '';
    const match = text.match(/\b(9|13|19|21|25)\s*[x×]\s*\1\b/);
    if (match) {
      setBoardSize(Number.parseInt(match[1], 10));
    }

    return boardSize || 19;
  }

  function getOutsideBoardMessage(localX, localY, rect) {
    const pastLeft = localX < 0;
    const pastRight = localX > rect.width;
    const pastTop = localY < 0;
    const pastBottom = localY > rect.height;

    if (!pastLeft && !pastRight && !pastTop && !pastBottom) {
      return null;
    }

    if (pastTop && pastLeft) {
      return 'Past the top-left corner. Move right and down.';
    }

    if (pastTop && pastRight) {
      return 'Past the top-right corner. Move left and down.';
    }

    if (pastBottom && pastLeft) {
      return 'Past the bottom-left corner. Move right and up.';
    }

    if (pastBottom && pastRight) {
      return 'Past the bottom-right corner. Move left and up.';
    }

    if (pastLeft) {
      return 'Past the left edge. Move right.';
    }

    if (pastRight) {
      return 'Past the right edge. Move left.';
    }

    if (pastTop) {
      return 'Past the top edge. Move down.';
    }

    return 'Past the bottom edge. Move up.';
  }

  function getHoverAnnouncementFromPoint(clientX, clientY, pointerTarget) {
    const boardSurface = findBoardSurface(clientX, clientY, pointerTarget);
    if (!boardSurface) {
      return null;
    }

    const boardSvg = getPointerBoardSvg(pointerTarget, clientX, clientY, boardSurface);
    const activeSurface = boardSvg || boardSurface;
    const rect = activeSurface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const svgMetrics = boardSvg ? parseGridMetricsFromSvg(boardSvg) : null;
    if (svgMetrics) {
      setBoardSize(svgMetrics.boardSize);
      const svgX = svgMetrics.coordinateSpace.x +
        (clientX - rect.left) * svgMetrics.coordinateSpace.width / rect.width;
      const svgY = svgMetrics.coordinateSpace.y +
        (clientY - rect.top) * svgMetrics.coordinateSpace.height / rect.height;
      const leftBound = svgMetrics.left - svgMetrics.xStep / 2;
      const rightBound = svgMetrics.right + svgMetrics.xStep / 2;
      const topBound = svgMetrics.top - svgMetrics.yStep / 2;
      const bottomBound = svgMetrics.bottom + svgMetrics.yStep / 2;
      const outsideMessage = getOutsideBoardMessage(
        svgX - leftBound,
        svgY - topBound,
        {
          width: rightBound - leftBound,
          height: bottomBound - topBound
        }
      );
      if (outsideMessage) {
        const hadRecentBoardAnnouncement =
          lastHoverAnnouncement !== null ||
          pendingHoverAnnouncement !== null ||
          activeHoverAnnouncement !== null;
        return hadRecentBoardAnnouncement ? outsideMessage : null;
      }

      const col = nearestIndex(svgMetrics.verticals, svgX);
      const row = nearestIndex(svgMetrics.horizontals, svgY);
      return toCoordinate(row, col, svgMetrics.boardSize);
    }
    return null;
  }

  function getBoardMetricsForHost(host) {
    if (!(host instanceof HTMLElement) || !host.shadowRoot) {
      return null;
    }

    const svg = host.shadowRoot.querySelector('svg');
    if (!(svg instanceof SVGSVGElement)) {
      return null;
    }

    const metrics = parseGridMetricsFromSvg(svg);
    if (!metrics) {
      return null;
    }

    setBoardSize(metrics.boardSize);
    return {
      svg,
      metrics
    };
  }

  function coordinateFromSvgPoint(metrics, x, y) {
    if (!metrics || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    const col = nearestIndex(metrics.verticals, x);
    const row = nearestIndex(metrics.horizontals, y);
    return toCoordinate(row, col, metrics.boardSize);
  }

  function normalizeEntryToBoardIntersection(metrics, entry, options = {}) {
    if (!entry) {
      return entry;
    }

    const rejectOrigin = options.rejectOrigin === true;
    const hasPoint = Number.isFinite(entry.x) && Number.isFinite(entry.y);
    const unusableOrigin = rejectOrigin && entry.x === 0 && entry.y === 0;
    const coordinate = hasPoint && !unusableOrigin
      ? coordinateFromSvgPoint(metrics, entry.x, entry.y)
      : null;

    return {
      ...entry,
      coordinate,
      intersectionKey: coordinate
    };
  }

  function collectStoneEntry(node) {
    if (!(node instanceof SVGUseElement)) {
      return null;
    }

    const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
    if (!href) {
      return null;
    }

    const point = extractNodePoint(node);
    return {
      href,
      color: parseStoneColorFromHref(href),
      opacity: parseNumericOpacity(
        node.getAttribute('opacity') ||
        window.getComputedStyle(node).opacity
      ),
      x: point?.x ?? null,
      y: point?.y ?? null,
      key: formatPointKey(point?.x, point?.y)
    };
  }

  function collectCircleEntry(node) {
    if (!(node instanceof SVGCircleElement)) {
      return null;
    }

    const point = extractNodePoint(node);
    return {
      className: node.getAttribute('class') || '',
      fill: node.getAttribute('fill') || '',
      stroke: node.getAttribute('stroke') || '',
      x: point?.x ?? null,
      y: point?.y ?? null,
      key: formatPointKey(point?.x, point?.y)
    };
  }

  function collectGridGroupEntry(node) {
    if (!(node instanceof SVGGElement)) {
      return null;
    }

    const parentClassName = node.parentElement?.getAttribute('class') || '';
    if (parentClassName !== 'grid') {
      return null;
    }

    const point = extractNodePoint(node);
    if (!point) {
      return null;
    }

    return {
      x: point.x,
      y: point.y,
      key: formatPointKey(point.x, point.y)
    };
  }

  function summarizeMoveBatch(batch) {
    return {
      hostGameId: batch.hostGameId,
      addedGridGroups: batch.addedGridGroups.map((entry) => ({
        key: entry.key,
        coordinate: entry.coordinate
      })),
      addedOpaqueStones: batch.addedOpaqueStones.map((entry) => ({
        key: entry.key,
        coordinate: entry.coordinate,
        color: entry.color
      })),
      addedPreviewStones: batch.addedPreviewStones.map((entry) => ({
        key: entry.key,
        coordinate: entry.coordinate,
        color: entry.color,
        opacity: entry.opacity
      })),
      removedPreviewStones: batch.removedPreviewStones.map((entry) => ({
        key: entry.key,
        coordinate: entry.coordinate,
        color: entry.color,
        opacity: entry.opacity
      })),
      removedOpaqueStones: batch.removedOpaqueStones.map((entry) => ({
        key: entry.key,
        coordinate: entry.coordinate,
        color: entry.color
      })),
      addedShadowCircles: batch.addedShadowCircles.map((entry) => ({
        key: entry.key,
        coordinate: entry.coordinate
      })),
      removedShadowCircles: batch.removedShadowCircles.map((entry) => ({
        key: entry.key,
        coordinate: entry.coordinate
      })),
      addedLastMoveMarkers: batch.addedLastMoveMarkers.length,
      removedLastMoveMarkers: batch.removedLastMoveMarkers.length,
      attributeMutations: batch.attributeMutations.length
    };
  }

  function isEmptyMoveBatch(batch) {
    return (
      batch.addedGridGroups.length === 0 &&
      batch.addedOpaqueStones.length === 0 &&
      batch.addedPreviewStones.length === 0 &&
      batch.removedPreviewStones.length === 0 &&
      batch.removedOpaqueStones.length === 0 &&
      batch.addedShadowCircles.length === 0 &&
      batch.removedShadowCircles.length === 0 &&
      batch.addedLastMoveMarkers.length === 0 &&
      batch.removedLastMoveMarkers.length === 0 &&
      batch.attributeMutations.length === 0
    );
  }

  function normalizeBoardMutationBatch(host, records, metrics) {
    const batch = {
      hostGameId: host.getAttribute('data-game-id'),
      addedGridGroups: [],
      addedOpaqueStones: [],
      addedPreviewStones: [],
      removedPreviewStones: [],
      removedOpaqueStones: [],
      addedShadowCircles: [],
      removedShadowCircles: [],
      addedLastMoveMarkers: [],
      removedLastMoveMarkers: [],
      attributeMutations: []
    };

    for (const record of records) {
      if (record.type === 'attributes') {
        batch.attributeMutations.push({
          tagName: record.target instanceof Element ? record.target.tagName : null,
          attributeName: record.attributeName || null
        });
      }

      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }

        const groupEntry = collectGridGroupEntry(node);
        if (groupEntry) {
          batch.addedGridGroups.push(normalizeEntryToBoardIntersection(metrics, groupEntry));
        }

        const stoneEntry = collectStoneEntry(node);
        if (stoneEntry) {
          const normalizedStoneEntry = normalizeEntryToBoardIntersection(metrics, stoneEntry);
          if (stoneEntry.opacity < 0.99) {
            batch.addedPreviewStones.push(normalizedStoneEntry);
          } else {
            batch.addedOpaqueStones.push(normalizedStoneEntry);
          }
        }

        const circleEntry = collectCircleEntry(node);
        if (circleEntry) {
          const normalizedCircleEntry = normalizeEntryToBoardIntersection(metrics, circleEntry);
          if (circleEntry.className.includes('last-move')) {
            batch.addedLastMoveMarkers.push(normalizedCircleEntry);
          } else if (circleEntry.fill.includes('shadow')) {
            batch.addedShadowCircles.push(normalizedCircleEntry);
          }
        }
      }

      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }

        const stoneEntry = collectStoneEntry(node);
        if (stoneEntry) {
          const normalizedStoneEntry = normalizeEntryToBoardIntersection(metrics, stoneEntry, { rejectOrigin: true });
          if (stoneEntry.opacity < 0.99) {
            batch.removedPreviewStones.push(normalizedStoneEntry);
          } else {
            batch.removedOpaqueStones.push(normalizedStoneEntry);
          }
        }

        const circleEntry = collectCircleEntry(node);
        if (circleEntry) {
          const normalizedCircleEntry = normalizeEntryToBoardIntersection(metrics, circleEntry, { rejectOrigin: true });
          if (circleEntry.className.includes('last-move')) {
            batch.removedLastMoveMarkers.push(normalizedCircleEntry);
          } else if (circleEntry.fill.includes('shadow')) {
            batch.removedShadowCircles.push(normalizedCircleEntry);
          }
        }
      }
    }

    return batch;
  }

  function findCommitPoint(batch) {
    const candidates = [
      ...batch.addedOpaqueStones,
      ...batch.addedShadowCircles,
      ...batch.addedGridGroups,
      ...batch.removedPreviewStones
    ];

    for (const candidate of candidates) {
      if (candidate?.intersectionKey) {
        return candidate;
      }
    }

    return null;
  }

  function classifyBoardMutationBatch(batch) {
    const summary = summarizeMoveBatch(batch);
    const markerOnly =
      batch.addedGridGroups.length === 0 &&
      batch.addedOpaqueStones.length === 0 &&
      batch.addedPreviewStones.length === 0 &&
      batch.removedPreviewStones.length === 0 &&
      batch.removedOpaqueStones.length === 0 &&
      batch.addedShadowCircles.length === 0 &&
      batch.removedShadowCircles.length === 0 &&
      (
        batch.addedLastMoveMarkers.length > 0 ||
        batch.removedLastMoveMarkers.length > 0 ||
        batch.attributeMutations.length > 0
      );
    if (markerOnly) {
      return {
        kind: 'marker-noise',
        reason: 'marker-only-noise',
        summary
      };
    }

    if (
      batch.addedPreviewStones.length > 0 &&
      batch.addedOpaqueStones.length === 0 &&
      batch.addedShadowCircles.length === 0 &&
      batch.addedLastMoveMarkers.length === 0 &&
      batch.removedLastMoveMarkers.length === 0
    ) {
      const preview = batch.addedPreviewStones.find((entry) => entry.intersectionKey) || batch.addedPreviewStones[0];
      if (preview?.intersectionKey) {
        rememberPreview(preview);
      }
      return {
        kind: 'preview',
        reason: 'translucent-stone-preview',
        point: preview,
        summary
      };
    }

    const commitPoint = findCommitPoint(batch);
    const hasOpaqueStone = batch.addedOpaqueStones.length > 0;
    const commitStone = batch.addedOpaqueStones.find(
      (entry) => entry.intersectionKey === commitPoint?.intersectionKey
    ) || batch.addedOpaqueStones[0];
    const hasShadowCircle = batch.addedShadowCircles.length > 0;
    const hasMarkerActivity =
      batch.addedLastMoveMarkers.length > 0 || batch.removedLastMoveMarkers.length > 0;
    const hasAddedGridGroup = batch.addedGridGroups.length > 0;
    const removedPreviewAtCommitPoint = commitPoint?.intersectionKey
      ? batch.removedPreviewStones.some((entry) => entry.intersectionKey === commitPoint.intersectionKey)
      : false;
    const recentPreviewAtCommitPoint = commitPoint?.intersectionKey
      ? wasRecentPreview(commitPoint.intersectionKey, commitStone?.color || null)
      : false;
    const shadowCircleAtCommitPoint = commitPoint?.intersectionKey
      ? batch.addedShadowCircles.some((entry) => entry.intersectionKey === commitPoint.intersectionKey)
      : false;
    const gridGroupAtCommitPoint = commitPoint?.intersectionKey
      ? batch.addedGridGroups.some((entry) => entry.intersectionKey === commitPoint.intersectionKey)
      : false;
    const decisionEvidence = {
      commitIntersection: commitPoint?.intersectionKey || null,
      commitPointKey: commitPoint?.key || null,
      hasOpaqueStone,
      hasShadowCircle,
      hasMarkerActivity,
      hasAddedGridGroup,
      removedPreviewAtCommitPoint,
      recentPreviewAtCommitPoint,
      shadowCircleAtCommitPoint,
      gridGroupAtCommitPoint,
      commitStoneColor: commitStone?.color || 'unknown'
    };

    if (
      commitPoint?.intersectionKey &&
      hasOpaqueStone &&
      hasShadowCircle &&
      hasMarkerActivity &&
      (removedPreviewAtCommitPoint || recentPreviewAtCommitPoint)
    ) {
      return {
        kind: 'move',
        source: 'local',
        reason: removedPreviewAtCommitPoint ? 'preview-promoted-to-local-move' : 'recent-preview-local-move',
        point: commitPoint,
        color: commitStone?.color || 'unknown',
        summary,
        evidence: decisionEvidence
      };
    }

    if (
      commitPoint?.intersectionKey &&
      hasOpaqueStone &&
      (hasAddedGridGroup || gridGroupAtCommitPoint || shadowCircleAtCommitPoint) &&
      hasMarkerActivity &&
      !recentPreviewAtCommitPoint
    ) {
      return {
        kind: 'move',
        source: 'remote',
        reason: 'remote-committed-move-shape',
        point: commitPoint,
        color: commitStone?.color || 'unknown',
        summary,
        evidence: decisionEvidence
      };
    }

    if (
      batch.removedPreviewStones.length > 0 &&
      batch.addedOpaqueStones.length === 0 &&
      batch.addedShadowCircles.length === 0 &&
      !hasMarkerActivity
    ) {
      return {
        kind: 'noise',
        reason: 'preview-removal-noise',
        summary
      };
    }

    return {
      kind: 'unmatched',
      reason: 'unmatched-batch-shape',
      summary
    };
  }

  function handleBoardMutationBatch(host, records) {
    const boardData = getBoardMetricsForHost(host);
    if (!boardData) {
      log('move batch unmatched', {
        reason: 'missing-board-svg-or-metrics',
        hostGameId: host.getAttribute('data-game-id')
      });
      return;
    }

    const batch = normalizeBoardMutationBatch(host, records, boardData.metrics);
    if (isEmptyMoveBatch(batch)) {
      return;
    }

    const classification = classifyBoardMutationBatch(batch);

    if (classification.kind === 'preview') {
      log('move batch classified', {
        kind: classification.kind,
        reason: classification.reason,
        translate: classification.point?.key || null
      });
      return;
    }

    if (classification.kind === 'marker-noise' || classification.kind === 'noise') {
      log('move batch classified', {
        kind: classification.kind,
        reason: classification.reason,
        summary: classification.summary
      });
      return;
    }

    if (classification.kind === 'unmatched') {
      log('move batch unmatched', {
        reason: classification.reason,
        summary: classification.summary
      });
      return;
    }

    const coordinate = coordinateFromSvgPoint(
      boardData.metrics,
      classification.point?.x,
      classification.point?.y
    );
    if (!coordinate) {
      log('move batch unmatched', {
        reason: 'could-not-map-point-to-coordinate',
        summary: classification.summary,
        point: classification.point?.key || null
      });
      return;
    }

    announceDetectedMove({
      source: classification.source,
      color: classification.color || 'unknown',
      coordinate,
      translate: classification.point?.key || null,
      reason: classification.reason,
      evidence: classification.evidence
    });
  }

  function maybeRecordBoardSizeFromObject(value) {
    if (!value || typeof value !== 'object') {
      return;
    }

    const width = typeof value.width === 'number' ? value.width : null;
    const height = typeof value.height === 'number' ? value.height : null;
    if (Number.isInteger(width) && Number.isInteger(height) && width === height) {
      setBoardSize(width);
    }
  }

  function extractMoveCoordinate(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    if (typeof payload.move === 'string') {
      return normalizeCoordinate(payload.move);
    }

    if (typeof payload.location === 'string') {
      return normalizeCoordinate(payload.location);
    }

    if (typeof payload.coordinate === 'string') {
      return normalizeCoordinate(payload.coordinate);
    }

    if (typeof payload.coords === 'string') {
      return normalizeCoordinate(payload.coords);
    }

    if (payload.move && typeof payload.move === 'object') {
      if (typeof payload.move.x === 'number' && typeof payload.move.y === 'number') {
        return coordinateFromXY(payload.move.x, payload.move.y);
      }
    }

    const looksLikeTopLevelMove =
      typeof payload.x === 'number' &&
      typeof payload.y === 'number' &&
      (
        'game_id' in payload ||
        'move_number' in payload ||
        'player' in payload ||
        'color' in payload ||
        'auth' in payload
      );
    if (looksLikeTopLevelMove) {
      return coordinateFromXY(payload.x, payload.y);
    }

    if (payload.vertex && typeof payload.vertex === 'string') {
      return normalizeCoordinate(payload.vertex);
    }

    if (payload.pass === true) {
      return 'pass';
    }

    return null;
  }

  function logDetectedMove(source, direction, coordinate, value) {
    log('move detected', {
      source,
      direction,
      coordinate,
      value: summarizeValue(value)
    });
  }

  function coordinateFromGobanLike(goban, x, y) {
    if (!goban || typeof goban !== 'object') {
      return coordinateFromXY(x, y);
    }

    try {
      if (typeof goban.prettyCoordinates === 'function') {
        return goban.prettyCoordinates(x, y);
      }
    } catch (error) {}

    try {
      if (goban.engine && typeof goban.engine.prettyCoordinates === 'function') {
        return goban.engine.prettyCoordinates(x, y);
      }
    } catch (error) {}

    return coordinateFromXY(x, y);
  }

  function looksLikeEngine(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      typeof value.place === 'function' &&
      typeof value.editPlace === 'function' &&
      typeof value.jumpTo === 'function' &&
      typeof value.decodeMoves === 'function'
    );
  }

  function looksLikeGoban(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      (
        typeof value.prettyCoordinates === 'function' ||
        looksLikeEngine(value.engine)
      )
    );
  }

  function instrumentMethod(target, methodName, formatter) {
    if (!target || typeof target[methodName] !== 'function' || instrumentedObjects.has(target[methodName])) {
      return;
    }

    const original = target[methodName];
    const wrapped = function(...args) {
      try {
        log(methodName, formatter.call(this, args));
      } catch (error) {
        log(`${methodName} formatter error`, summarizeValue(String(error)));
      }
      return original.apply(this, args);
    };

    instrumentedObjects.add(wrapped);
    target[methodName] = wrapped;
  }

  function instrumentGobanLike(goban, reason) {
    if (!goban || typeof goban !== 'object' || instrumentedObjects.has(goban)) {
      return false;
    }

    instrumentedObjects.add(goban);
    const engine = looksLikeEngine(goban) ? goban : goban.engine;
    log('instrumentGobanLike', {
      reason,
      hasEngine: Boolean(engine),
      keys: Object.keys(goban).slice(0, 20)
    });

    if (engine && typeof engine === 'object') {
      instrumentMethod(engine, 'place', function(args) {
        const [x, y] = args;
        return {
          source: reason,
          coordinate: coordinateFromGobanLike(goban, x, y),
          x,
          y,
          args: summarizeValue(args),
          cur_move_before: summarizeMoveNode(this.cur_move)
        };
      });

      instrumentMethod(engine, 'editPlace', function(args) {
        const [x, y, color] = args;
        return {
          source: reason,
          coordinate: coordinateFromGobanLike(goban, x, y),
          x,
          y,
          color,
          args: summarizeValue(args),
          cur_move_before: summarizeMoveNode(this.cur_move)
        };
      });

      instrumentMethod(engine, 'jumpTo', function(args) {
        return {
          source: reason,
          args: summarizeValue(args),
          target: summarizeMoveNode(args[0]),
          cur_move_before: summarizeMoveNode(this.cur_move)
        };
      });
    }

    installedGobanInstrumentation = true;
    return true;
  }

  function searchForGobanLike(root, reason, seen = new WeakSet(), depth = 0) {
    if (!root || typeof root !== 'object' || seen.has(root) || depth > 4) {
      return false;
    }
    seen.add(root);

    if (looksLikeGoban(root) || looksLikeEngine(root)) {
      return instrumentGobanLike(root, reason);
    }

    let keys = [];
    try {
      keys = Object.getOwnPropertyNames(root);
    } catch (error) {
      return false;
    }

    for (const key of keys.slice(0, 40)) {
      let value = null;
      try {
        value = root[key];
      } catch (error) {
        continue;
      }

      if (!value || typeof value !== 'object') {
        continue;
      }

      if (searchForGobanLike(value, `${reason}.${key}`, seen, depth + 1)) {
        return true;
      }
    }

    return false;
  }

  function installGobanInstrumentation() {
    if (installedGobanInstrumentation) {
      return;
    }

    const hosts = document.querySelectorAll('.Goban[data-game-id], .Goban[data-pointers-bound="true"]');
    for (const host of hosts) {
      if (host instanceof HTMLElement) {
        installBoardMutationObserver(host);
      }

      if (searchForGobanLike(host, 'host')) {
        return;
      }

      if (host instanceof HTMLElement && host.shadowRoot && searchForGobanLike(host.shadowRoot, 'shadowRoot')) {
        return;
      }
    }

    if (searchForGobanLike(window, 'window')) {
      return;
    }

    if (!loggedMissingGobanCandidate) {
      loggedMissingGobanCandidate = true;
      log('installGobanInstrumentation scan found no goban candidate');
    }
  }

  function startGobanInstrumentationScan() {
    installGobanInstrumentation();
    if (installedGobanInstrumentation) {
      return;
    }

    gobanScanTimerId = window.setInterval(() => {
      if (installedGobanInstrumentation) {
        if (gobanScanTimerId !== null) {
          clearInterval(gobanScanTimerId);
          gobanScanTimerId = null;
        }
        return;
      }

      installGobanInstrumentation();
    }, GOBAN_SCAN_INTERVAL_MS);
  }

  function walkPayload(value, visitor, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    visitor(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        walkPayload(entry, visitor, seen);
      }
      return;
    }

    for (const key of Object.keys(value)) {
      walkPayload(value[key], visitor, seen);
    }
  }

  function analyzePayload(payload, direction) {
    log('analyzePayload', {
      direction,
      payload: summarizeValue(payload)
    });

    walkPayload(payload, (value) => {
      maybeRecordBoardSizeFromObject(value);
      const coordinate = extractMoveCoordinate(value);
      if (!coordinate) {
        return;
      }

      logDetectedMove('payload', direction, coordinate, value);

      if (direction === 'outgoing') {
        rememberLocalMove(coordinate);
      }
    });
  }

  function parseSocketPayload(raw) {
    if (typeof raw !== 'string') {
      return raw;
    }

    const firstJsonChar = raw.search(/[\[{]/);
    if (firstJsonChar === -1) {
      return null;
    }

    const candidate = raw.slice(firstJsonChar);
    try {
      const parsed = JSON.parse(candidate);
      log('parseSocketPayload success', {
        prefixOffset: firstJsonChar,
        payload: summarizeValue(parsed)
      });
      return parsed;
    } catch (error) {
      log('parseSocketPayload failed', {
        prefixOffset: firstJsonChar,
        raw: summarizeValue(candidate)
      });
      return null;
    }
  }

  function analyzeRawText(raw, direction) {
    if (typeof raw !== 'string') {
      return;
    }

    log('analyzeRawText', {
      direction,
      raw: summarizeValue(raw)
    });

    const parsed = parseSocketPayload(raw);
    if (parsed) {
      analyzePayload(parsed, direction);
    }

    const sgfMoveMatch = raw.match(/"move"\s*:\s*"([a-z]{2}|pass|\.\.)"/i);
    if (sgfMoveMatch) {
      const coordinate = normalizeCoordinate(sgfMoveMatch[1]);
      logDetectedMove('raw.move', direction, coordinate, sgfMoveMatch[1]);
      if (direction === 'outgoing') {
        rememberLocalMove(coordinate);
      }
    }

    const xyMatch = raw.match(/"x"\s*:\s*(-?\d+)[^]*?"y"\s*:\s*(-?\d+)/i);
    if (xyMatch) {
      const coordinate = coordinateFromXY(Number.parseInt(xyMatch[1], 10), Number.parseInt(xyMatch[2], 10));
      logDetectedMove('raw.xy', direction, coordinate, { x: xyMatch[1], y: xyMatch[2] });
      if (direction === 'outgoing') {
        rememberLocalMove(coordinate);
      }
    }

    const boardSizeMatch = raw.match(/"width"\s*:\s*(\d+)[^]*?"height"\s*:\s*(\d+)/i);
    if (boardSizeMatch) {
      const width = Number.parseInt(boardSizeMatch[1], 10);
      const height = Number.parseInt(boardSizeMatch[2], 10);
      if (width === height) {
        setBoardSize(width);
      }
    }
  }

  function installWebSocketHooks() {
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== 'function') {
      return;
    }

    window.WebSocket = function(...args) {
      log('WebSocket created', {
        url: summarizeValue(args[0])
      });
      const socket = new NativeWebSocket(...args);
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          log('WebSocket message', {
            direction: 'incoming',
            raw: summarizeValue(event.data)
          });
          analyzeRawText(event.data, 'incoming');
        }
      });

      const nativeSend = socket.send;
      socket.send = function(data) {
        if (typeof data === 'string') {
          log('WebSocket send', {
            direction: 'outgoing',
            raw: summarizeValue(data)
          });
          analyzeRawText(data, 'outgoing');
        }
        return nativeSend.call(this, data);
      };

      return socket;
    };

    window.WebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(window.WebSocket, NativeWebSocket);
  }

  function installFetchHook() {
    if (typeof window.fetch !== 'function') {
      return;
    }

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);

      try {
        const clone = response.clone();
        const contentType = clone.headers.get('content-type') || '';
        const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || response.url;
        const shouldInspect =
          response.url.includes('/api/') ||
          response.url.includes('/termination-api/') ||
          response.url.includes('/game/');
        if (!shouldInspect) {
          return response;
        }

        log('fetch response', {
          url: requestUrl,
          responseUrl: response.url,
          contentType
        });

        if (contentType.includes('application/json')) {
          clone.json().then((data) => {
            log('fetch json body', {
              url: response.url,
              payload: summarizeValue(data)
            });
            analyzePayload(data, 'incoming');
          }).catch(() => {});
        } else if (contentType.includes('text/')) {
          clone.text().then((text) => {
            log('fetch text body', {
              url: response.url,
              raw: summarizeValue(text)
            });
            analyzeRawText(text, 'incoming');
          }).catch(() => {});
        }
      } catch (error) {}

      return response;
    };
  }

  function installXhrHook() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__ogsAudioMethod = typeof method === 'string' ? method : '';
      this.__ogsAudioUrl = typeof url === 'string' ? url : '';
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
      if (this.__ogsAudioUrl) {
        log('xhr send', {
          method: this.__ogsAudioMethod,
          url: this.__ogsAudioUrl,
          body: summarizeValue(body)
        });
      }

      if (typeof body === 'string') {
        analyzeRawText(body, 'outgoing');
      }

      this.addEventListener('load', () => {
        try {
          const shouldInspect =
            typeof this.responseURL === 'string' &&
            (
              this.responseURL.includes('/api/') ||
              this.responseURL.includes('/termination-api/') ||
              this.responseURL.includes('/game/')
            );
          if (!shouldInspect) {
            return;
          }

          log('xhr load', {
            method: this.__ogsAudioMethod,
            url: this.__ogsAudioUrl,
            responseURL: this.responseURL,
            responseType: this.responseType
          });

          if (typeof this.responseText === 'string' && this.responseText) {
            log('xhr text body', {
              url: this.responseURL,
              raw: summarizeValue(this.responseText)
            });
            analyzeRawText(this.responseText, 'incoming');
          }
        } catch (error) {}
      });

      return originalSend.call(this, body);
    };
  }

  function installPointerHook() {
    document.addEventListener(
      'pointermove',
      (event) => {
        const message = getHoverAnnouncementFromPoint(event.clientX, event.clientY, event.target);
        if (!message) {
          cancelHoverUtteranceIfLeaving(null);
          clearPendingHoverAnnouncement();
          lastHoverAnnouncement = null;
          return;
        }

        cancelHoverUtteranceIfLeaving(message);
        maybeAnnounceHover(message);
      },
      true
    );
  }

  installWebSocketHooks();
  installFetchHook();
  installXhrHook();
  installPointerHook();
  log(`script boot version=${SCRIPT_VERSION}`);
  startGobanInstrumentationScan();
})();
