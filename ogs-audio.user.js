// ==UserScript==
// @name         OGS Blind Audio
// @namespace    https://online-go.com/
// @version      0.1.2
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
  const LOG_PREFIX = '[ogs-audio]';
  const DEBUG_LOGGING = true;

  let boardSize = null;
  let lastAnnouncedRemoteMove = null;
  let lastHoverAnnouncement = null;
  let pendingHoverAnnouncement = null;
  let hoverTimerId = null;
  let activeHoverUtterance = null;
  let activeHoverAnnouncement = null;
  const recentLocalMoves = [];

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
    log(`${name}()`, details);
  }

  function speak(text) {
    logFunction('speak', { text });
    if (typeof speechSynthesis === 'undefined' || !text) {
      log('speak skipped', { hasSpeechSynthesis: typeof speechSynthesis !== 'undefined', text });
      return;
    }

    const msg = new SpeechSynthesisUtterance(text);
    speechSynthesis.speak(msg);
  }

  function speakHoverAnnouncement(message) {
    logFunction('speakHoverAnnouncement', { message });
    if (typeof speechSynthesis === 'undefined' || !message) {
      log('speakHoverAnnouncement skipped', { hasSpeechSynthesis: typeof speechSynthesis !== 'undefined', message });
      return;
    }

    const msg = new SpeechSynthesisUtterance(message);
    activeHoverUtterance = msg;
    activeHoverAnnouncement = message;
    msg.addEventListener('end', () => {
      log('hover utterance ended', { message });
      if (activeHoverUtterance === msg) {
        activeHoverUtterance = null;
        activeHoverAnnouncement = null;
      }
    });
    msg.addEventListener('error', () => {
      log('hover utterance errored', { message });
      if (activeHoverUtterance === msg) {
        activeHoverUtterance = null;
        activeHoverAnnouncement = null;
      }
    });
    speechSynthesis.speak(msg);
  }

  function cancelHoverUtteranceIfLeaving(message) {
    logFunction('cancelHoverUtteranceIfLeaving', {
      message,
      activeHoverAnnouncement
    });
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
    logFunction('clearPendingHoverAnnouncement', { pendingHoverAnnouncement, hoverTimerId });
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
    logFunction('decodeSgfPoint', { point });
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
    logFunction('normalizeCoordinate', { value });
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
    logFunction('coordinateFromXY', { x, y, boardSize: getBoardSize() });
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
    logFunction('rememberLocalMove', { coordinate });
    if (!coordinate) {
      return;
    }

    const now = Date.now();
    recentLocalMoves.push({ coordinate, at: now });
    pruneRecentLocalMoves(now);
  }

  function pruneRecentLocalMoves(now = Date.now()) {
    logFunction('pruneRecentLocalMoves', { now, countBefore: recentLocalMoves.length });
    while (recentLocalMoves.length > 0 && now - recentLocalMoves[0].at > LOCAL_MOVE_MEMORY_MS) {
      recentLocalMoves.shift();
    }
    log('pruneRecentLocalMoves result', { countAfter: recentLocalMoves.length });
  }

  function isRecentLocalMove(coordinate) {
    logFunction('isRecentLocalMove', { coordinate });
    pruneRecentLocalMoves();
    return recentLocalMoves.some((entry) => entry.coordinate === coordinate);
  }

  function announceRemoteMove(coordinate) {
    logFunction('announceRemoteMove', {
      coordinate,
      lastAnnouncedRemoteMove
    });
    if (!coordinate || coordinate === lastAnnouncedRemoteMove || isRecentLocalMove(coordinate)) {
      log('announceRemoteMove skipped', {
        coordinate,
        lastAnnouncedRemoteMove,
        recentLocal: coordinate ? isRecentLocalMove(coordinate) : null
      });
      return;
    }

    lastAnnouncedRemoteMove = coordinate;
    if (coordinate === 'pass') {
      speak('Opponent passes');
      return;
    }

    speak(`Opponent plays ${coordinate}`);
  }

  function maybeAnnounceHover(message) {
    logFunction('maybeAnnounceHover', {
      message,
      lastHoverAnnouncement,
      pendingHoverAnnouncement
    });
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
      log('hover settle timer fired', { message, pendingHoverAnnouncement });
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
    let score = rect.width * rect.height;
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

  function findBoardSurface(clientX, clientY, pointerTarget) {
    logFunction('findBoardSurface', {
      clientX,
      clientY,
      pointerTarget: pointerTarget instanceof Element ? describeBoardCandidate(pointerTarget) : null
    });
    const rawCandidates = [];
    collectAncestorCandidates(pointerTarget, rawCandidates, 'pointer-target');

    if (Number.isFinite(clientX) && Number.isFinite(clientY) && typeof document.elementsFromPoint === 'function') {
      const stack = document.elementsFromPoint(clientX, clientY);
      log('elementsFromPoint stack', stack.slice(0, 8).map((element) => describeBoardCandidate(element)));
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

      const score = scoreBoardCandidate(candidate, rect);
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

    log('findBoardSurface result', {
      rawCandidateCount: rawCandidates.length,
      scoredCandidateCount: scoredCandidates.length,
      topCandidates: scoredCandidates
        .sort((left, right) => right.score - left.score)
        .slice(0, 5),
      bestTagName: best ? best.tagName : null,
      bestId: best ? best.id : null,
      bestClassName: best ? String(best.className || '') : null,
      bestScore
    });
    return best;
  }

  function setBoardSize(value) {
    logFunction('setBoardSize', { value, previousBoardSize: boardSize });
    if (!Number.isInteger(value) || value < 2 || value > MAX_BOARD_SIZE) {
      log('setBoardSize rejected', { value });
      return;
    }

    boardSize = value;
    log('boardSize updated', { boardSize });
  }

  function getBoardSize() {
    logFunction('getBoardSize', { boardSize });
    if (boardSize) {
      return boardSize;
    }

    const text = document.body?.innerText || '';
    const match = text.match(/\b(9|13|19|21|25)\s*[x×]\s*\1\b/);
    if (match) {
      setBoardSize(Number.parseInt(match[1], 10));
    }

    log('getBoardSize result', { boardSize: boardSize || 19 });
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
    logFunction('getHoverAnnouncementFromPoint', {
      clientX,
      clientY,
      pointerTarget: pointerTarget instanceof Element ? describeBoardCandidate(pointerTarget) : null
    });
    const boardSurface = findBoardSurface(clientX, clientY, pointerTarget);
    if (!boardSurface) {
      log('getHoverAnnouncementFromPoint found no board surface');
      return null;
    }

    const size = getBoardSize();
    const rect = boardSurface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      log('getHoverAnnouncementFromPoint invalid rect', describeBoardCandidate(boardSurface));
      return null;
    }

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const outsideMessage = getOutsideBoardMessage(localX, localY, rect);
    if (outsideMessage) {
      log('getHoverAnnouncementFromPoint outside board', {
        outsideMessage,
        localX,
        localY,
        boardSurface: describeBoardCandidate(boardSurface)
      });
      const hadRecentBoardAnnouncement =
        lastHoverAnnouncement !== null ||
        pendingHoverAnnouncement !== null ||
        activeHoverAnnouncement !== null;
      return hadRecentBoardAnnouncement ? outsideMessage : null;
    }

    const cellSize = rect.width / size;
    if (cellSize <= 0) {
      log('getHoverAnnouncementFromPoint invalid cell size', { cellSize, size, rect: describeBoardCandidate(boardSurface) });
      return null;
    }

    const col = clamp(Math.round(localX / cellSize - 0.5), 0, size - 1);
    const row = clamp(Math.round(localY / cellSize - 0.5), 0, size - 1);
    const coordinate = toCoordinate(row, col, size);
    log('getHoverAnnouncementFromPoint result', {
      coordinate,
      row,
      col,
      size,
      cellSize,
      boardSurface: describeBoardCandidate(boardSurface)
    });
    return coordinate;
  }

  function maybeRecordBoardSizeFromObject(value) {
    logFunction('maybeRecordBoardSizeFromObject', {
      width: value && value.width,
      height: value && value.height
    });
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
    logFunction('extractMoveCoordinate', {
      keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : null
    });
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
    logFunction('analyzePayload', {
      direction,
      payloadType: Array.isArray(payload) ? 'array' : typeof payload
    });
    walkPayload(payload, (value) => {
      maybeRecordBoardSizeFromObject(value);
      const coordinate = extractMoveCoordinate(value);
      if (!coordinate) {
        return;
      }

      log('analyzePayload found coordinate', { direction, coordinate, value });
      if (direction === 'outgoing') {
        rememberLocalMove(coordinate);
      } else {
        announceRemoteMove(coordinate);
      }
    });
  }

  function parseSocketPayload(raw) {
    logFunction('parseSocketPayload', {
      rawPreview: typeof raw === 'string' ? raw.slice(0, 160) : raw
    });
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
      log('parseSocketPayload parsed JSON', {
        parsedType: Array.isArray(parsed) ? 'array' : typeof parsed
      });
      return parsed;
    } catch (error) {
      log('parseSocketPayload failed', { error: String(error) });
      return null;
    }
  }

  function analyzeRawText(raw, direction) {
    logFunction('analyzeRawText', {
      direction,
      rawPreview: typeof raw === 'string' ? raw.slice(0, 200) : raw
    });
    if (typeof raw !== 'string') {
      return;
    }

    const parsed = parseSocketPayload(raw);
    if (parsed) {
      analyzePayload(parsed, direction);
    }

    const sgfMoveMatch = raw.match(/"move"\s*:\s*"([a-z]{2}|pass|\.\.)"/i);
    if (sgfMoveMatch) {
      const coordinate = normalizeCoordinate(sgfMoveMatch[1]);
      log('analyzeRawText SGF move match', { direction, coordinate, match: sgfMoveMatch[0] });
      if (direction === 'outgoing') {
        rememberLocalMove(coordinate);
      } else {
        announceRemoteMove(coordinate);
      }
    }

    const xyMatch = raw.match(/"x"\s*:\s*(-?\d+)[^]*?"y"\s*:\s*(-?\d+)/i);
    if (xyMatch) {
      const coordinate = coordinateFromXY(Number.parseInt(xyMatch[1], 10), Number.parseInt(xyMatch[2], 10));
      log('analyzeRawText XY match', { direction, coordinate, match: xyMatch[0] });
      if (direction === 'outgoing') {
        rememberLocalMove(coordinate);
      } else {
        announceRemoteMove(coordinate);
      }
    }

    const boardSizeMatch = raw.match(/"width"\s*:\s*(\d+)[^]*?"height"\s*:\s*(\d+)/i);
    if (boardSizeMatch) {
      const width = Number.parseInt(boardSizeMatch[1], 10);
      const height = Number.parseInt(boardSizeMatch[2], 10);
      log('analyzeRawText board size match', { width, height });
      if (width === height) {
        setBoardSize(width);
      }
    }
  }

  function installWebSocketHooks() {
    logFunction('installWebSocketHooks');
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== 'function') {
      log('installWebSocketHooks skipped: WebSocket unavailable');
      return;
    }

    window.WebSocket = function(...args) {
      log('WebSocket constructor intercepted', { args });
      const socket = new NativeWebSocket(...args);
      socket.addEventListener('message', (event) => {
        log('WebSocket message event', {
          dataType: typeof event.data,
          dataPreview: typeof event.data === 'string' ? event.data.slice(0, 200) : event.data
        });
        if (typeof event.data === 'string') {
          analyzeRawText(event.data, 'incoming');
        }
      });

      const nativeSend = socket.send;
      socket.send = function(data) {
        log('WebSocket.send intercepted', {
          dataType: typeof data,
          dataPreview: typeof data === 'string' ? data.slice(0, 200) : data
        });
        if (typeof data === 'string') {
          analyzeRawText(data, 'outgoing');
        }
        return nativeSend.call(this, data);
      };

      return socket;
    };

    window.WebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(window.WebSocket, NativeWebSocket);
    log('installWebSocketHooks complete');
  }

  function installFetchHook() {
    logFunction('installFetchHook');
    if (typeof window.fetch !== 'function') {
      log('installFetchHook skipped: fetch unavailable');
      return;
    }

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      log('fetch intercepted', { args });
      const response = await originalFetch.apply(this, args);

      try {
        const clone = response.clone();
        const contentType = clone.headers.get('content-type') || '';
        const shouldInspect =
          response.url.includes('/api/') ||
          response.url.includes('/termination-api/') ||
          response.url.includes('/game/');
        log('fetch response received', {
          url: response.url,
          status: response.status,
          contentType,
          shouldInspect
        });
        if (!shouldInspect) {
          return response;
        }

        if (contentType.includes('application/json')) {
          clone.json().then((data) => {
            analyzePayload(data, 'incoming');
          }).catch(() => {});
        } else if (contentType.includes('text/')) {
          clone.text().then((text) => {
            analyzeRawText(text, 'incoming');
          }).catch(() => {});
        }
      } catch (error) {}

      return response;
    };
    log('installFetchHook complete');
  }

  function installXhrHook() {
    logFunction('installXhrHook');
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      log('XMLHttpRequest.open intercepted', { method, url });
      this.__ogsAudioUrl = typeof url === 'string' ? url : '';
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
      log('XMLHttpRequest.send intercepted', {
        url: this.__ogsAudioUrl,
        bodyType: typeof body,
        bodyPreview: typeof body === 'string' ? body.slice(0, 200) : body
      });
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
          log('XMLHttpRequest load event', {
            responseURL: this.responseURL,
            status: this.status,
            shouldInspect
          });
          if (!shouldInspect) {
            return;
          }

          if (typeof this.responseText === 'string' && this.responseText) {
            analyzeRawText(this.responseText, 'incoming');
          }
        } catch (error) {}
      });

      return originalSend.call(this, body);
    };
    log('installXhrHook complete');
  }

  function installPointerHook() {
    logFunction('installPointerHook');
    document.addEventListener(
      'pointermove',
      (event) => {
        log('pointermove intercepted', {
          clientX: event.clientX,
          clientY: event.clientY,
          targetTagName: event.target && event.target.tagName
        });
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
    log('installPointerHook complete');
  }

  log('script boot', {
    href: window.location.href,
    readyState: document.readyState
  });
  installWebSocketHooks();
  installFetchHook();
  installXhrHook();
  installPointerHook();
  log('script initialized');
})();
