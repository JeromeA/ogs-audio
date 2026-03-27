// ==UserScript==
// @name         OGS Blind Audio
// @namespace    https://online-go.com/
// @version      0.1.0
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

  let boardSize = null;
  let lastAnnouncedRemoteMove = null;
  let lastHoverAnnouncement = null;
  let pendingHoverAnnouncement = null;
  let hoverTimerId = null;
  let activeHoverUtterance = null;
  let activeHoverAnnouncement = null;
  const recentLocalMoves = [];

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

    const now = Date.now();
    recentLocalMoves.push({ coordinate, at: now });
    pruneRecentLocalMoves(now);
  }

  function pruneRecentLocalMoves(now = Date.now()) {
    while (recentLocalMoves.length > 0 && now - recentLocalMoves[0].at > LOCAL_MOVE_MEMORY_MS) {
      recentLocalMoves.shift();
    }
  }

  function isRecentLocalMove(coordinate) {
    pruneRecentLocalMoves();
    return recentLocalMoves.some((entry) => entry.coordinate === coordinate);
  }

  function announceRemoteMove(coordinate) {
    if (!coordinate || coordinate === lastAnnouncedRemoteMove || isRecentLocalMove(coordinate)) {
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
    let score = rect.width * rect.height;
    const lowerClass = String(element.className || '').toLowerCase();
    const lowerId = String(element.id || '').toLowerCase();

    if (lowerClass.includes('goban') || lowerClass.includes('board')) {
      score += 200000;
    }

    if (lowerId.includes('goban') || lowerId.includes('board')) {
      score += 100000;
    }

    if (element.closest('[id="main-content"]')) {
      score += 50000;
    }

    return score;
  }

  function findBoardSurface() {
    const candidates = document.querySelectorAll('canvas, svg');
    let best = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement || candidate instanceof SVGElement)) {
        continue;
      }

      const rect = candidate.getBoundingClientRect();
      if (!isVisibleSquare(rect)) {
        continue;
      }

      const style = window.getComputedStyle(candidate);
      if (style.visibility === 'hidden' || style.display === 'none') {
        continue;
      }

      const score = scoreBoardCandidate(candidate, rect);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
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

  function getHoverAnnouncementFromPoint(clientX, clientY) {
    const boardSurface = findBoardSurface();
    if (!boardSurface) {
      return null;
    }

    const size = getBoardSize();
    const rect = boardSurface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const outsideMessage = getOutsideBoardMessage(localX, localY, rect);
    if (outsideMessage) {
      const hadRecentBoardAnnouncement =
        lastHoverAnnouncement !== null ||
        pendingHoverAnnouncement !== null ||
        activeHoverAnnouncement !== null;
      return hadRecentBoardAnnouncement ? outsideMessage : null;
    }

    const cellSize = rect.width / size;
    if (cellSize <= 0) {
      return null;
    }

    const col = clamp(Math.round(localX / cellSize - 0.5), 0, size - 1);
    const row = clamp(Math.round(localY / cellSize - 0.5), 0, size - 1);
    return toCoordinate(row, col, size);
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
    walkPayload(payload, (value) => {
      maybeRecordBoardSizeFromObject(value);
      const coordinate = extractMoveCoordinate(value);
      if (!coordinate) {
        return;
      }

      if (direction === 'outgoing') {
        rememberLocalMove(coordinate);
      } else {
        announceRemoteMove(coordinate);
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
      return JSON.parse(candidate);
    } catch (error) {
      return null;
    }
  }

  function analyzeRawText(raw, direction) {
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
      if (direction === 'outgoing') {
        rememberLocalMove(coordinate);
      } else {
        announceRemoteMove(coordinate);
      }
    }

    const xyMatch = raw.match(/"x"\s*:\s*(-?\d+)[^]*?"y"\s*:\s*(-?\d+)/i);
    if (xyMatch) {
      const coordinate = coordinateFromXY(Number.parseInt(xyMatch[1], 10), Number.parseInt(xyMatch[2], 10));
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
      const socket = new NativeWebSocket(...args);
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          analyzeRawText(event.data, 'incoming');
        }
      });

      const nativeSend = socket.send;
      socket.send = function(data) {
        if (typeof data === 'string') {
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
        const shouldInspect =
          response.url.includes('/api/') ||
          response.url.includes('/termination-api/') ||
          response.url.includes('/game/');
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
  }

  function installXhrHook() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__ogsAudioUrl = typeof url === 'string' ? url : '';
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
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

          if (typeof this.responseText === 'string' && this.responseText) {
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
        const message = getHoverAnnouncementFromPoint(event.clientX, event.clientY);
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
})();
