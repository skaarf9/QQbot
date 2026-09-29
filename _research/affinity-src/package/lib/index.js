"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../packages/shared-chatluna-xmltools/lib/index.js
var require_lib = __commonJS({
  "../../packages/shared-chatluna-xmltools/lib/index.js"(exports2, module2) {
    "use strict";
    var __defProp2 = Object.defineProperty;
    var __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames2 = Object.getOwnPropertyNames;
    var __hasOwnProp2 = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
      for (var name2 in all)
        __defProp2(target, name2, { get: all[name2], enumerable: true });
    };
    var __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS2 = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    var index_exports2 = {};
    __export2(index_exports2, {
      createCharacterTempRuntime: () => createCharacterTempRuntime2,
      extractAssistantText: () => extractAssistantText,
      extractTextContent: () => extractTextContent,
      getMessageType: () => getMessageType,
      isAssistantMessage: () => isAssistantMessage,
      parseSelfClosingXmlTags: () => parseSelfClosingXmlTags2,
      registerGetTempListener: () => registerGetTempListener,
      subscribeAssistantResponses: () => subscribeAssistantResponses
    });
    module2.exports = __toCommonJS2(index_exports2);
    function parseSelfClosingXmlTags2(text, tagName) {
      const tags = Array.from(
        text.matchAll(new RegExp(`<${tagName}\\b([^>]*)\\/>`, "gi"))
      );
      if (!tags.length) return [];
      return tags.map((tag) => {
        const attrText = String(tag[1] || "");
        const attrs = {};
        for (const pair of attrText.matchAll(/([a-zA-Z_][\w-]*)="([^"]*)"/g)) {
          attrs[pair[1]] = pair[2];
        }
        return attrs;
      });
    }
    function getMessageType(message) {
      if (!message) return "";
      if (typeof message._getType === "function") {
        return String(message._getType() || "").trim().toLowerCase();
      }
      return String(message.type || message.role || "").trim().toLowerCase();
    }
    function isAssistantMessage(message) {
      const type = getMessageType(message);
      return type === "assistant" || type === "ai";
    }
    function extractTextContent(value) {
      if (typeof value === "string") return value;
      if (value == null) return "";
      if (Array.isArray(value)) {
        return value.map((item) => extractTextContent(item)).join("");
      }
      if (typeof value !== "object") return "";
      const record = value;
      if (typeof record.text === "string") return record.text;
      if (record.content !== void 0 && record.content !== value) {
        return extractTextContent(record.content);
      }
      if (Array.isArray(record.children)) {
        return extractTextContent(record.children);
      }
      if (typeof record.attrs === "object" && record.attrs) {
        const attrs = record.attrs;
        if (typeof attrs.content === "string") return attrs.content;
        if (typeof attrs.text === "string") return attrs.text;
      }
      return "";
    }
    function extractAssistantText(message) {
      if (!isAssistantMessage(message)) return "";
      return extractTextContent(message?.content ?? message?.text).trim();
    }
    var GET_TEMP_TAG_PREFIX = "chatlunaXmlToolsGetTempTag";
    var GET_TEMP_ORIGINAL_PREFIX = "chatlunaXmlToolsGetTempOriginal";
    var GET_TEMP_LISTENERS_PREFIX = "chatlunaXmlToolsGetTempListeners";
    function resolveSymbolNamespace(namespace) {
      return namespace?.trim() || "default";
    }
    function resolveGetTempTag(namespace) {
      return /* @__PURE__ */ Symbol.for(`${GET_TEMP_TAG_PREFIX}:${resolveSymbolNamespace(namespace)}`);
    }
    function resolveGetTempOriginal(namespace) {
      return /* @__PURE__ */ Symbol.for(
        `${GET_TEMP_ORIGINAL_PREFIX}:${resolveSymbolNamespace(namespace)}`
      );
    }
    function resolveGetTempListeners(namespace) {
      return /* @__PURE__ */ Symbol.for(
        `${GET_TEMP_LISTENERS_PREFIX}:${resolveSymbolNamespace(namespace)}`
      );
    }
    function registerGetTempListener(service, listener, options = {}) {
      const getTemp = service.getTemp;
      if (typeof getTemp !== "function") return null;
      const tagKey = resolveGetTempTag(options.symbolNamespace);
      const originalKey = resolveGetTempOriginal(options.symbolNamespace);
      const listenersKey = resolveGetTempListeners(options.symbolNamespace);
      const serviceRecord = service;
      let listeners = serviceRecord[listenersKey];
      if (!listeners) {
        listeners = /* @__PURE__ */ new Set();
        serviceRecord[listenersKey] = listeners;
      }
      if (!serviceRecord[tagKey]) {
        Object.defineProperty(serviceRecord, originalKey, {
          value: getTemp,
          configurable: true,
          enumerable: false,
          writable: true
        });
        service.getTemp = async (...args) => {
          const originalGetTemp = serviceRecord[originalKey];
          const temp = await originalGetTemp?.apply(service, args);
          const activeListeners = serviceRecord[listenersKey];
          const session = options.resolveSession ? options.resolveSession(args) : args[0] && typeof args[0] === "object" ? args[0] : null;
          if (temp && activeListeners?.size) {
            for (const handler of Array.from(activeListeners)) {
              handler(temp, session);
            }
          }
          return temp;
        };
        serviceRecord[tagKey] = true;
      }
      listeners.add(listener);
      return () => {
        const currentListeners = serviceRecord[listenersKey];
        currentListeners?.delete(listener);
        if (currentListeners?.size) return;
        const originalGetTemp = serviceRecord[originalKey];
        if (originalGetTemp && service.getTemp !== originalGetTemp) {
          service.getTemp = originalGetTemp;
        }
        delete serviceRecord[originalKey];
        delete serviceRecord[tagKey];
        delete serviceRecord[listenersKey];
      };
    }
    var PUSH_DISPATCHER_PREFIX = "chatlunaXmlToolsPushDispatcher";
    function resolvePushDispatcherKey(namespace) {
      const target = namespace?.trim() || "default";
      return /* @__PURE__ */ Symbol.for(`${PUSH_DISPATCHER_PREFIX}:${target}`);
    }
    function getDispatcher(messages, key) {
      return messages[key] ?? null;
    }
    function setDispatcher(messages, key, dispatcher) {
      const record = messages;
      if (!dispatcher) {
        delete record[key];
        return;
      }
      Object.defineProperty(record, key, {
        value: dispatcher,
        configurable: true,
        enumerable: false,
        writable: true
      });
    }
    function createMessageFingerprint(message, response) {
      const type = String(message.type ?? message.role ?? "").trim().toLowerCase();
      return `${type}:${response}`;
    }
    function restoreDispatcher(key, dispatcher) {
      if (dispatcher.messages.push === dispatcher.patchedPush) {
        dispatcher.messages.push = dispatcher.originalPush;
      }
      setDispatcher(dispatcher.messages, key, null);
    }
    function subscribeAssistantResponses(messages, options) {
      const key = resolvePushDispatcherKey(options.symbolNamespace);
      let dispatcher = getDispatcher(messages, key);
      if (!dispatcher) {
        const listeners = /* @__PURE__ */ new Set();
        const processedMessages = /* @__PURE__ */ new WeakMap();
        const originalPush = messages.push;
        const patchedPush = function patchedPush2(...items) {
          const result = originalPush.apply(this, items);
          for (const item of items) {
            if (!item || typeof item !== "object") continue;
            const message = item;
            const response = extractAssistantText(message);
            if (!response) continue;
            const fingerprint = createMessageFingerprint(
              item,
              response
            );
            const previousFingerprint = processedMessages.get(item);
            if (previousFingerprint === fingerprint) continue;
            processedMessages.set(item, fingerprint);
            for (const listener2 of Array.from(listeners)) {
              try {
                listener2(message);
              } catch (error) {
                options.onListenerError?.(error);
              }
            }
          }
          return result;
        };
        dispatcher = {
          messages,
          originalPush,
          patchedPush,
          listeners,
          processedMessages
        };
        messages.push = patchedPush;
        setDispatcher(messages, key, dispatcher);
      }
      const listener = (message) => {
        const response = extractAssistantText(message);
        if (!response) return;
        options.onResponse({
          response,
          message,
          session: options.getSession?.() ?? null
        });
      };
      dispatcher.listeners.add(listener);
      return () => {
        const current = getDispatcher(messages, key);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size > 0) return;
        restoreDispatcher(key, current);
      };
    }
    function createCharacterTempRuntime2(options) {
      const {
        getCharacterService,
        symbolNamespace,
        onResponse,
        getMessages = (temp) => temp?.completionMessages,
        resolveSession,
        onServiceMissing,
        onServiceChanged,
        onBound,
        onStarted,
        onResponseError,
        onListenerError
      } = options;
      const messageSubscriptions = /* @__PURE__ */ new WeakMap();
      const sessionByMessages = /* @__PURE__ */ new WeakMap();
      const trackedMessages = /* @__PURE__ */ new Set();
      let detachGetTempListener = null;
      let activeService = null;
      let active = false;
      const cleanupMessageSubscriptions = () => {
        for (const messages of Array.from(trackedMessages)) {
          messageSubscriptions.get(messages)?.();
          messageSubscriptions.delete(messages);
          sessionByMessages.delete(messages);
          trackedMessages.delete(messages);
        }
      };
      const cleanupServiceBinding = () => {
        detachGetTempListener?.();
        detachGetTempListener = null;
        activeService = null;
        active = false;
      };
      const handleTemp = (temp, session) => {
        const messages = getMessages(temp);
        if (!Array.isArray(messages) || typeof messages.push !== "function") return;
        sessionByMessages.set(messages, session);
        if (messageSubscriptions.has(messages)) return;
        const unsubscribe = subscribeAssistantResponses(messages, {
          symbolNamespace,
          getSession: () => sessionByMessages.get(messages) ?? null,
          onListenerError,
          onResponse: ({ response, message, session: boundSession }) => {
            const text = response || extractAssistantText(message);
            if (!text) return;
            void Promise.resolve(
              onResponse({
                response: text,
                message,
                session: boundSession
              })
            ).catch((error) => {
              onResponseError?.(error);
            });
          }
        });
        trackedMessages.add(messages);
        messageSubscriptions.set(messages, () => {
          unsubscribe();
          trackedMessages.delete(messages);
          sessionByMessages.delete(messages);
        });
      };
      const bindCurrentService = () => {
        const service = getCharacterService();
        if (!service || typeof service.getTemp !== "function") {
          cleanupServiceBinding();
          cleanupMessageSubscriptions();
          onServiceMissing?.();
          return { bound: false, changed: false, missing: true };
        }
        if (detachGetTempListener && activeService === service) {
          active = true;
          onServiceChanged?.({
            changed: false,
            previousService: activeService,
            nextService: service
          });
          return { bound: true, changed: false, missing: false };
        }
        const previousService = activeService;
        cleanupServiceBinding();
        cleanupMessageSubscriptions();
        const detach = registerGetTempListener(service, handleTemp, {
          symbolNamespace,
          resolveSession
        });
        if (!detach) {
          onServiceMissing?.();
          return { bound: false, changed: false, missing: true };
        }
        detachGetTempListener = detach;
        activeService = service;
        active = true;
        onServiceChanged?.({
          changed: previousService !== service,
          previousService,
          nextService: service
        });
        onBound?.({ service });
        return {
          bound: true,
          changed: previousService !== service,
          missing: false
        };
      };
      return {
        start: () => {
          const { bound, changed, missing } = bindCurrentService();
          if (!bound) {
            if (!missing) {
              onServiceMissing?.();
            }
            return false;
          }
          onStarted?.({ changed });
          return true;
        },
        stop: () => {
          cleanupServiceBinding();
          cleanupMessageSubscriptions();
        },
        isActive: () => active
      };
    }
  }
});

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ACTION_WINDOW_DEFAULTS: () => ACTION_WINDOW_DEFAULTS,
  AFFINITY_DEFAULTS: () => AFFINITY_DEFAULTS,
  AFFINITY_DYNAMICS_DEFAULTS: () => AFFINITY_DYNAMICS_DEFAULTS,
  ALL_MEMBER_INFO_ITEMS: () => ALL_MEMBER_INFO_ITEMS,
  AffinitySchema: () => AffinitySchema,
  BASE_AFFINITY_DEFAULTS: () => BASE_AFFINITY_DEFAULTS,
  BLACKLIST_MODEL_NAME: () => BLACKLIST_MODEL_NAME,
  BLACKLIST_MODEL_NAME_V2: () => BLACKLIST_MODEL_NAME_V2,
  BLACKLIST_REPLY_TEMPLATE: () => BLACKLIST_REPLY_TEMPLATE,
  BlacklistSchema: () => BlacklistSchema,
  CLOUD_TYPES: () => CLOUD_TYPES,
  COEFFICIENT_DEFAULTS: () => COEFFICIENT_DEFAULTS,
  COMMON_STYLE: () => COMMON_STYLE,
  Config: () => ConfigSchema,
  ConfigSchema: () => ConfigSchema,
  DASHBOARD_SNAPSHOT_MODEL_NAME: () => DASHBOARD_SNAPSHOT_MODEL_NAME,
  DEFAULT_MEMBER_INFO_ITEMS: () => DEFAULT_MEMBER_INFO_ITEMS,
  FETCH_CONSTANTS: () => FETCH_CONSTANTS,
  MIGRATION_MODEL_NAME: () => MIGRATION_MODEL_NAME,
  MODEL_NAME: () => MODEL_NAME,
  MODEL_NAME_V2: () => MODEL_NAME_V2,
  NativeToolSettingsSchema: () => NativeToolSettingsSchema,
  OtherSettingsSchema: () => OtherSettingsSchema,
  RENDER_CONSTANTS: () => RENDER_CONSTANTS,
  ROLE_MAPPING: () => ROLE_MAPPING,
  RelationshipSchema: () => RelationshipSchema,
  SHORT_TERM_DEFAULTS: () => SHORT_TERM_DEFAULTS,
  THRESHOLDS: () => THRESHOLDS,
  TIME_CONSTANTS: () => TIME_CONSTANTS,
  TIMING_CONSTANTS: () => TIMING_CONSTANTS,
  USER_AFFINITY_SNAPSHOT_MODEL_NAME: () => USER_AFFINITY_SNAPSHOT_MODEL_NAME,
  USER_ALIAS_MODEL_NAME: () => USER_ALIAS_MODEL_NAME,
  USER_ALIAS_MODEL_NAME_V2: () => USER_ALIAS_MODEL_NAME_V2,
  XmlToolSettingsSchema: () => XmlToolSettingsSchema,
  appendActionEntry: () => appendActionEntry,
  apply: () => apply,
  applyAffinityDelta: () => applyAffinityDelta,
  assertScopeId: () => assertScopeId,
  buildAffinityMechanismPrompt: () => buildAffinityMechanismPrompt,
  buildScopedCommandName: () => buildScopedCommandName,
  callOneBotAPI: () => callOneBotAPI,
  clamp: () => clamp,
  clampFloat: () => clampFloat,
  collectNicknameCandidates: () => collectNicknameCandidates,
  collectRoleCandidates: () => collectRoleCandidates,
  composeState: () => composeState,
  computeCoefficientValue: () => computeCoefficientValue,
  computeDailyStreak: () => computeDailyStreak,
  computeShortTermReset: () => computeShortTermReset,
  createAffinityCache: () => createAffinityCache,
  createAffinityProvider: () => createAffinityProvider,
  createAffinityStore: () => createAffinityStore,
  createBlacklistGuard: () => createBlacklistGuard,
  createBlacklistListProvider: () => createBlacklistListProvider,
  createBlacklistRenderer: () => createBlacklistRenderer,
  createBlacklistService: () => createBlacklistService,
  createCharacterTempModelResponseRuntime: () => createCharacterTempModelResponseRuntime,
  createInspectRenderer: () => createInspectRenderer,
  createLevelResolver: () => createLevelResolver,
  createLogger: () => createLogger,
  createManualRelationshipManager: () => createManualRelationshipManager,
  createMessageHistory: () => createMessageHistory,
  createMessageStore: () => createMessageStore,
  createMigrationService: () => createMigrationService,
  createModelResponseProcessor: () => createModelResponseProcessor,
  createPermanentUnblockHandler: () => createPermanentUnblockHandler,
  createRankListRenderer: () => createRankListRenderer,
  createRelationshipLevelProvider: () => createRelationshipLevelProvider,
  createRenderService: () => createRenderService,
  createTableRenderer: () => createTableRenderer,
  createUserAliasService: () => createUserAliasService,
  dayNumber: () => dayNumber,
  ensureOneBotSession: () => ensureOneBotSession,
  escapeHtml: () => escapeHtml,
  extendAffinityModel: () => extendAffinityModel,
  extendBlacklistModel: () => extendBlacklistModel,
  extendDashboardSnapshotModel: () => extendDashboardSnapshotModel,
  extendMigrationModel: () => extendMigrationModel,
  extendUserAliasModel: () => extendUserAliasModel,
  fetchGroupMemberIds: () => fetchGroupMemberIds,
  fetchMember: () => fetchMember,
  findMemberByName: () => findMemberByName,
  formatActionCounts: () => formatActionCounts,
  formatBeijingTimestamp: () => formatBeijingTimestamp,
  formatDateOnly: () => formatDateOnly,
  formatDateTime: () => formatDateTime,
  formatTimestamp: () => formatTimestamp,
  getChannelId: () => getChannelId,
  getDateString: () => getDateString,
  getGuildId: () => getGuildId,
  getPlatform: () => getPlatform,
  getRoleDisplay: () => getRoleDisplay,
  getSelfId: () => getSelfId,
  getTimeString: () => getTimeString,
  getUserId: () => getUserId,
  hasReplyToolsEnabled: () => hasReplyToolsEnabled,
  inject: () => inject,
  isFiniteNumber: () => isFiniteNumber,
  isValidScopeId: () => isValidScopeId,
  makeUserKey: () => makeUserKey,
  name: () => name,
  normalizeScopeId: () => normalizeScopeId,
  normalizeTimestamp: () => normalizeTimestamp,
  pickFirst: () => pickFirst,
  registerActiveScope: () => registerActiveScope,
  registerAdjustCommand: () => registerAdjustCommand,
  registerAffinityMechanismPromptInjection: () => registerAffinityMechanismPromptInjection,
  registerBlacklistCommand: () => registerBlacklistCommand,
  registerBlockCommand: () => registerBlockCommand,
  registerCharacterPromptInjection: () => registerCharacterPromptInjection,
  registerCharacterReplyTools: () => registerCharacterReplyTools,
  registerClearAllCommand: () => registerClearAllCommand,
  registerInspectCommand: () => registerInspectCommand,
  registerModels: () => registerModels,
  registerNativeTools: () => registerNativeTools,
  registerRankCommand: () => registerRankCommand,
  registerTempBlockCommand: () => registerTempBlockCommand,
  renderHtml: () => renderHtml,
  renderInfoField: () => renderInfoField,
  renderMemberInfo: () => renderMemberInfo,
  renderTemplate: () => renderTemplate,
  resolveActionWindowConfig: () => resolveActionWindowConfig,
  resolveBotInfo: () => resolveBotInfo,
  resolveCoefficientConfig: () => resolveCoefficientConfig,
  resolveGroupId: () => resolveGroupId,
  resolveRoleLabel: () => resolveRoleLabel,
  resolveScopedVariableArgs: () => resolveScopedVariableArgs,
  resolveShortTermConfig: () => resolveShortTermConfig,
  resolveUserIdentity: () => resolveUserIdentity,
  resolveUserInfo: () => resolveUserInfo,
  resolveXmlScopeId: () => resolveXmlScopeId,
  roundTo: () => roundTo,
  sanitizeChannel: () => sanitizeChannel,
  stripAtPrefix: () => stripAtPrefix,
  summarizeActionEntries: () => summarizeActionEntries,
  toDate: () => toDate,
  translateGender: () => translateGender,
  translateRole: () => translateRole,
  truncate: () => truncate,
  usage: () => usage
});
module.exports = __toCommonJS(index_exports);

// src/schema/index.ts
var import_koishi5 = require("koishi");

// src/schema/affinity.ts
var import_koishi = require("koishi");

// src/constants/defaults.ts
var AFFINITY_DEFAULTS = {
  MIN: 0,
  MAX: 100,
  INITIAL_MIN: 20,
  INITIAL_MAX: 40
};
var SHORT_TERM_DEFAULTS = {
  PROMOTE_THRESHOLD: 15,
  DEMOTE_THRESHOLD: -15,
  LONG_TERM_STEP: 3
};
var ACTION_WINDOW_DEFAULTS = {
  WINDOW_HOURS: 24,
  INCREASE_BONUS: 2,
  DECREASE_BONUS: 2,
  BONUS_CHAT_THRESHOLD: 0,
  MAX_ENTRIES: 60
};
var COEFFICIENT_DEFAULTS = {
  BASE: 1,
  MAX_DROP: 0.3,
  MAX_BOOST: 0.3,
  DECAY_PER_DAY_RATIO: 3,
  BOOST_PER_DAY_RATIO: 3,
  FALLBACK_DECAY: 0.1,
  FALLBACK_BOOST: 0.1
};
var TIME_CONSTANTS = {
  MS_PER_SECOND: 1e3,
  MS_PER_MINUTE: 60 * 1e3,
  MS_PER_HOUR: 60 * 60 * 1e3,
  MS_PER_DAY: 24 * 60 * 60 * 1e3,
  SECONDS_THRESHOLD: 1e11
};
var THRESHOLDS = {
  BLACKLIST_DEFAULT: -50,
  MIN_ENTRIES: 10,
  MIN_WINDOW_HOURS: 1,
  UNBLOCK_PERMANENT_INITIAL_AFFINITY: 10
};
var RENDER_CONSTANTS = {
  VIEWPORT_WIDTH: 800,
  VIEWPORT_BASE_HEIGHT: 220,
  VIEWPORT_ROW_HEIGHT: 48
};
var TIMING_CONSTANTS = {
  ANALYSIS_TIMEOUT: 3e4,
  BOT_REPLY_DELAY: 3e3,
  SCHEDULE_RETRY_DELAY: 2e3,
  SCHEDULE_CHECK_INTERVAL: 6e4
};
var FETCH_CONSTANTS = {
  HISTORY_LIMIT_MULTIPLIER: 6,
  MIN_HISTORY_LIMIT: 60,
  RANK_FETCH_MULTIPLIER: 5,
  RANK_FETCH_OFFSET: 20,
  MAX_RANK_FETCH: 200
};
var BASE_AFFINITY_DEFAULTS = {
  initialAffinity: 30
};
var AFFINITY_DYNAMICS_DEFAULTS = {
  shortTerm: {
    promoteThreshold: 15,
    demoteThreshold: -10,
    longTermPromoteStep: 3,
    longTermDemoteStep: 5
  },
  actionWindow: {
    windowHours: 24,
    increaseBonus: 2,
    decreaseBonus: 2,
    bonusChatThreshold: 10,
    maxEntries: 80
  },
  coefficient: {
    base: 1,
    maxDrop: 0.3,
    maxBoost: 0.3,
    decayPerDay: 0.05,
    boostPerDay: 0.05
  }
};

// src/constants/prompts.ts
var BLACKLIST_REPLY_TEMPLATE = "";

// src/constants/mappings.ts
var ROLE_MAPPING = {
  direct: {
    owner: "\u7FA4\u4E3B",
    \u7FA4\u4E3B: "\u7FA4\u4E3B",
    \u4E3B\u4EBA: "\u7FA4\u4E3B",
    \u623F\u4E3B: "\u7FA4\u4E3B",
    \u4F1A\u957F: "\u7FA4\u4E3B",
    \u56E2\u957F: "\u7FA4\u4E3B",
    admin: "\u7BA1\u7406\u5458",
    administrator: "\u7BA1\u7406\u5458",
    manager: "\u7BA1\u7406\u5458",
    \u7BA1\u7406\u5458: "\u7BA1\u7406\u5458",
    \u7BA1\u7406: "\u7BA1\u7406\u5458",
    member: "\u7FA4\u5458",
    members: "\u7FA4\u5458",
    normal: "\u7FA4\u5458",
    user: "\u7FA4\u5458",
    participant: "\u7FA4\u5458",
    \u7FA4\u5458: "\u7FA4\u5458",
    \u6210\u5458: "\u7FA4\u5458",
    \u666E\u901A\u6210\u5458: "\u7FA4\u5458",
    \u666E\u901A\u7FA4\u5458: "\u7FA4\u5458"
  },
  keywords: {
    owner: ["owner", "host", "leader", "master", "boss"],
    admin: ["admin", "manager", "moderator", "administrator"],
    member: ["member", "user", "participant", "normal"]
  },
  numeric: {
    "2": "\u7FA4\u4E3B",
    "1": "\u7BA1\u7406\u5458",
    "0": "\u7FA4\u5458"
  }
};
var CLOUD_TYPES = {
  aliyundrive: "\u963F\u91CC\u4E91\u76D8",
  baiduwangpan: "\u767E\u5EA6\u7F51\u76D8",
  quark: "\u5938\u514B\u7F51\u76D8",
  xunlei: "\u8FC5\u96F7\u4E91\u76D8",
  "115": "115\u7F51\u76D8",
  tianyi: "\u5929\u7FFC\u4E91\u76D8",
  googledrive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  mega: "MEGA",
  pikpak: "PikPak",
  uc: "UC\u7F51\u76D8"
};
var DEFAULT_MEMBER_INFO_ITEMS = [
  "nickname",
  "userId",
  "role",
  "level",
  "title"
];
var ALL_MEMBER_INFO_ITEMS = [
  "nickname",
  "userId",
  "role",
  "level",
  "title",
  "gender",
  "age",
  "area",
  "joinTime",
  "lastSentTime",
  "chatCount"
];

// src/schema/affinity.ts
var AffinityDynamicsSchema = import_koishi.Schema.object({
  disableShortTermAffinity: import_koishi.Schema.boolean().default(false).description("\u5173\u95ED\u77ED\u671F\u597D\u611F\uFF0C\u6240\u6709\u589E\u51CF\u503C\u76F4\u63A5\u4F5C\u7528\u4E8E\u957F\u671F\u597D\u611F"),
  disableAffinityCoefficient: import_koishi.Schema.boolean().default(false).description("\u5173\u95ED\u597D\u611F\u5EA6\u53D8\u5316\u7CFB\u6570\uFF0C\u6700\u7EC8\u597D\u611F\u5EA6\u76F4\u63A5\u663E\u793A\u957F\u671F\u597D\u611F\u5EA6"),
  shortTerm: import_koishi.Schema.object({
    promoteThreshold: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.shortTerm.promoteThreshold).description("\u77ED\u671F\u597D\u611F\u8FBE\u5230\u8BE5\u503C\u540E\uFF0C\u589E\u52A0\u957F\u671F\u597D\u611F"),
    demoteThreshold: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.shortTerm.demoteThreshold).description("\u77ED\u671F\u597D\u611F\u4F4E\u4E8E\u8BE5\u503C\u540E\uFF0C\u51CF\u5C11\u957F\u671F\u597D\u611F"),
    longTermPromoteStep: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.shortTerm.longTermPromoteStep).min(1).description("\u6BCF\u6B21\u589E\u52A0\u7684\u957F\u671F\u597D\u611F\u503C"),
    longTermDemoteStep: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.shortTerm.longTermDemoteStep).min(1).description("\u6BCF\u6B21\u51CF\u5C11\u7684\u957F\u671F\u597D\u611F\u503C")
  }).description("\u77ED\u671F\u4E0E\u957F\u671F\u597D\u611F\u8BBE\u7F6E").collapse(),
  actionWindow: import_koishi.Schema.object({
    windowHours: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.actionWindow.windowHours).min(1).description("\u7EDF\u8BA1\u8FD1\u671F\u4E92\u52A8\u7684\u65F6\u95F4\u7A97\u53E3\uFF0C\u5355\u4F4D\u4E3A\u5C0F\u65F6"),
    increaseBonus: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.actionWindow.increaseBonus).description("\u5F53\u8FD1\u671F\u6B63\u5411\u4E92\u52A8\u5360\u4F18\u65F6\uFF0C\u989D\u5916\u589E\u52A0\u7684\u597D\u611F\u5EA6"),
    decreaseBonus: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.actionWindow.decreaseBonus).description("\u5F53\u8FD1\u671F\u8D1F\u5411\u4E92\u52A8\u5360\u4F18\u65F6\uFF0C\u989D\u5916\u51CF\u5C11\u7684\u597D\u611F\u5EA6"),
    bonusChatThreshold: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.actionWindow.bonusChatThreshold).min(0).description("\u4E92\u52A8\u6B21\u6570\u8FBE\u5230\u8BE5\u503C\u540E\uFF0C\u624D\u542F\u7528\u989D\u5916\u589E\u51CF\u6548\u679C"),
    maxEntries: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.actionWindow.maxEntries).min(10).description("\u65F6\u95F4\u7A97\u53E3\u5185\u6700\u591A\u4FDD\u7559\u7684\u4E92\u52A8\u8BB0\u5F55\u6570")
  }).description("\u8FD1\u671F\u4E92\u52A8\u6743\u91CD\u8BBE\u7F6E").collapse(),
  coefficient: import_koishi.Schema.object({
    base: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.coefficient.base).description("\u597D\u611F\u5EA6\u53D8\u5316\u7684\u57FA\u7840\u7CFB\u6570"),
    maxDrop: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.coefficient.maxDrop).min(0).step(0.1).description("\u5728\u957F\u671F\u51B7\u6DE1\u6216\u8D1F\u5411\u4E92\u52A8\u5360\u4F18\u65F6\uFF0C\u7CFB\u6570\u6700\u591A\u53EF\u4E0B\u8C03\u7684\u5E45\u5EA6"),
    maxBoost: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.coefficient.maxBoost).min(0).step(0.1).description("\u5728\u6301\u7EED\u4E92\u52A8\u4E14\u6B63\u5411\u4E92\u52A8\u5360\u4F18\u65F6\uFF0C\u7CFB\u6570\u6700\u591A\u53EF\u4E0A\u8C03\u7684\u5E45\u5EA6"),
    decayPerDay: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.coefficient.decayPerDay).min(0).step(0.05).description("\u6BCF\u7ECF\u8FC7\u4E00\u5929\u51B7\u6DE1\u671F\u6216\u8D1F\u5411\u5360\u4F18\u671F\u65F6\uFF0C\u7CFB\u6570\u7684\u4E0B\u8C03\u5E45\u5EA6"),
    boostPerDay: import_koishi.Schema.number().default(AFFINITY_DYNAMICS_DEFAULTS.coefficient.boostPerDay).min(0).step(0.05).description("\u6BCF\u7ECF\u8FC7\u4E00\u5929\u7A33\u5B9A\u4E92\u52A8\u4E14\u6B63\u5411\u5360\u4F18\u65F6\uFF0C\u7CFB\u6570\u7684\u4E0A\u8C03\u5E45\u5EA6")
  }).description("\u597D\u611F\u5EA6\u53D8\u5316\u7CFB\u6570").collapse()
}).description(
  "\u597D\u611F\u5EA6\u52A8\u6001\u8C03\u8282\uFF1ABot \u6BCF\u6B21\u589E\u52A0\u6216\u51CF\u5C11\u7684\u503C\u4F1A\u5148\u8BA1\u5165\u77ED\u671F\u597D\u611F\uFF1B\u5F53\u77ED\u671F\u597D\u611F\u8D85\u8FC7\u9608\u503C\u65F6\uFF0C\u4F1A\u6309\u8BBE\u5B9A\u6B65\u957F\u6362\u7B97\u5230\u957F\u671F\u597D\u611F\uFF1B\u957F\u671F\u597D\u611F\u518D\u4E58\u4EE5\u5F53\u524D\u7CFB\u6570\uFF0C\u5F97\u5230\u6700\u7EC8\u7684\u7EFC\u5408\u597D\u611F\u3002"
);
var AffinitySchema = import_koishi.Schema.object({
  affinityEnabled: import_koishi.Schema.boolean().default(true).description("\u542F\u7528\u597D\u611F\u5EA6\u7CFB\u7EDF"),
  autoInjectAffinityMechanismPrompt: import_koishi.Schema.boolean().default(true).description("\u5C06\u5F53\u524D\u597D\u611F\u5EA6\u8FD0\u4F5C\u673A\u5236\u4F5C\u4E3A\u7CFB\u7EDF\u63D0\u793A\u8BCD\u6CE8\u5165\u6A21\u578B"),
  initialAffinity: import_koishi.Schema.number().default(BASE_AFFINITY_DEFAULTS.initialAffinity).description("\u521D\u59CB\u957F\u671F\u597D\u611F\u5EA6\u9ED8\u8BA4\u503C"),
  affinityDynamics: AffinityDynamicsSchema.collapse(),
  rankDefaultLimit: import_koishi.Schema.number().default(10).min(1).max(50).description("\u597D\u611F\u5EA6\u6392\u884C\u9ED8\u8BA4\u5C55\u793A\u4EBA\u6570")
}).description("\u597D\u611F\u5EA6\u8BBE\u7F6E");

// src/schema/blacklist.ts
var import_koishi2 = require("koishi");
var BlacklistSchema = import_koishi2.Schema.object({
  blacklistLogInterception: import_koishi2.Schema.boolean().default(true).description("\u62E6\u622A\u6D88\u606F\u65F6\u8F93\u51FA\u65E5\u5FD7"),
  shortTermBlacklistPenalty: import_koishi2.Schema.number().default(5).min(0).description("\u4E34\u65F6\u62C9\u9ED1\u65F6\u989D\u5916\u6263\u51CF\u7684\u957F\u671F\u597D\u611F\u5EA6"),
  unblockPermanentInitialAffinity: import_koishi2.Schema.number().default(THRESHOLDS.UNBLOCK_PERMANENT_INITIAL_AFFINITY).description("\u89E3\u9664\u6C38\u4E45\u9ED1\u540D\u5355\u540E\u91CD\u7F6E\u7684\u521D\u59CB\u597D\u611F\u5EA6"),
  blacklistDefaultLimit: import_koishi2.Schema.number().default(10).min(1).max(100).description("\u9ED1\u540D\u5355\u9ED8\u8BA4\u5C55\u793A\u4EBA\u6570")
}).description("\u9ED1\u540D\u5355\u8BBE\u7F6E");

// src/schema/relationship.ts
var import_koishi3 = require("koishi");
var RelationshipSchema = import_koishi3.Schema.object({
  relationships: import_koishi3.Schema.array(
    import_koishi3.Schema.object({
      userId: import_koishi3.Schema.string().default("").description("\u7528\u6237 ID"),
      relation: import_koishi3.Schema.string().default("").description("\u5173\u7CFB"),
      note: import_koishi3.Schema.string().default("").description("\u5907\u6CE8")
    })
  ).role("table").default([]).description("\u7279\u6B8A\u5173\u7CFB\u914D\u7F6E\uFF08\u5220\u9664\u540E\u9700\u624B\u52A8\u6E05\u7406\u6570\u636E\u5E93\u4E2D\u5BF9\u5E94\u7528\u6237\u7684\u5173\u7CFB\u5B57\u6BB5\uFF09"),
  relationshipAffinityLevels: import_koishi3.Schema.array(
    import_koishi3.Schema.object({
      min: import_koishi3.Schema.number().default(0).description("\u597D\u611F\u5EA6\u4E0B\u9650"),
      max: import_koishi3.Schema.number().default(100).description("\u597D\u611F\u5EA6\u4E0A\u9650"),
      relation: import_koishi3.Schema.string().description("\u5173\u7CFB"),
      note: import_koishi3.Schema.string().default("").description("\u5907\u6CE8")
    })
  ).role("table").default([
    {
      min: -9999,
      max: 0,
      relation: "\u538C\u6076",
      note: "\u4F1A\u6781\u5176\u6577\u884D\u3001\u51B7\u6DE1\uFF0C\u751A\u81F3\u53EF\u80FD\u9009\u62E9\u65E0\u89C6\u3002\u76EE\u7684\u662F\u5C3D\u5FEB\u7ED3\u675F\u5BF9\u8BDD\u3002"
    },
    {
      min: 1,
      max: 50,
      relation: "\u964C\u751F",
      note: "\u4EC5\u4E3A\u70B9\u5934\u4E4B\u4EA4\uFF0C\u7F3A\u4E4F\u6DF1\u5165\u4E86\u89E3\uFF0C\u4E92\u52A8\u5C40\u9650\u4E8E\u793C\u8C8C\u5C42\u9762\u3002"
    },
    {
      min: 51,
      max: 120,
      relation: "\u719F\u6089",
      note: "\u5F7C\u6B64\u8BA4\u8BC6\uFF0C\u53EF\u4EE5\u8FDB\u884C\u65E5\u5E38\u4EA4\u6D41\uFF0C\u5F00\u59CB\u4F7F\u7528\u4E00\u4E9B\u8F7B\u677E\u7684\u8BED\u6C14\u8BCD\uFF0C\u5C55\u73B0\u51FA\u66F4\u591A\u4E2A\u6027\u3002"
    },
    {
      min: 121,
      max: 180,
      relation: "\u53CB\u597D",
      note: "\u4E92\u6709\u597D\u611F\uFF0C\u613F\u610F\u4E3B\u52A8\u5206\u4EAB\u81EA\u5DF1\u7684\u7ECF\u5386\u548C\u611F\u53D7\uFF0C\u662F\u503C\u5F97\u4FE1\u8D56\u7684\u670B\u53CB\u3002"
    },
    {
      min: 181,
      max: 9999,
      relation: "\u4EB2\u5BC6",
      note: "\u5173\u7CFB\u975E\u5E38\u4EB2\u5BC6\uFF0C\u4F1A\u6BEB\u65E0\u987E\u5FCC\u5730\u5F00\u73A9\u7B11\u3001\u5410\u69FD\uFF0C\u4E5F\u4F1A\u81EA\u7136\u5730\u6492\u5A07\u548C\u5206\u4EAB\u81EA\u5DF1\u7684\u5C0F\u60C5\u7EEA\u3002"
    }
  ]).description("\u597D\u611F\u5EA6\u533A\u95F4\u5173\u7CFB")
}).description("\u5173\u7CFB\u8BBE\u7F6E");

// src/schema/tools.ts
var import_koishi4 = require("koishi");

// src/services/native-tools/defaults.ts
var DEFAULT_AFFINITY_NATIVE_TOOL_DESCRIPTION = "\u8C03\u6574\u4E00\u4E2A\u7528\u6237\u7684\u597D\u611F\u5EA6\u3002";
var DEFAULT_BLACKLIST_NATIVE_TOOL_DESCRIPTION = "\u65B0\u589E\u6216\u79FB\u9664\u4E00\u4E2A\u7528\u6237\u7684\u9ED1\u540D\u5355\u3002";
var DEFAULT_RELATIONSHIP_NATIVE_TOOL_DESCRIPTION = "\u8BBE\u7F6E\u6216\u6E05\u7A7A\u4E00\u4E2A\u7528\u6237\u7684\u5173\u7CFB\u3002";
var DEFAULT_USER_ALIAS_NATIVE_TOOL_DESCRIPTION = "\u8BBE\u7F6E\u4E00\u4E2A\u7528\u6237\u7684\u81EA\u5B9A\u4E49\u6635\u79F0\u3002";

// src/schema/tools.ts
var ScopeSettingsSchema = import_koishi4.Schema.object({
  scopeId: import_koishi4.Schema.string().pattern(/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,32}$/).required().description(
    "\u4F5C\u7528\u57DF\u6807\u8BC6\uFF0C\u53EA\u5141\u8BB8\u4E2D\u6587\u3001\u82F1\u6587\u3001\u6570\u5B57\u3001_\u3001-\uFF0C\u957F\u5EA6 1-32\uFF1B\u4E0D\u8981\u4F7F\u7528\u4E0E bot \u540D\u79F0\u76F8\u540C\u7684 scopeId\uFF0C\u5EFA\u8BAE\u4F18\u5148\u4F7F\u7528\u82F1\u6587"
  ),
  botSelfIds: import_koishi4.Schema.array(import_koishi4.Schema.string()).default([]).description(
    "\u586B\u5199\u8BE5 scopeId \u7ED1\u5B9A\u7684 bot \u7684 selfId\uFF08QQ\u53F7\uFF09\uFF1B\u4E3A\u7A7A\u65F6\u8868\u793A\u5F53\u524D\u5B9E\u4F8B\u4EFB\u610F bot"
  )
}).description("\u4F5C\u7528\u57DF\u8BBE\u7F6E");
var EnabledNativeToolsSchema = import_koishi4.Schema.array(
  import_koishi4.Schema.union([
    import_koishi4.Schema.const("affinity").description("\u597D\u611F\u5EA6"),
    import_koishi4.Schema.const("blacklist").description("\u9ED1\u540D\u5355"),
    import_koishi4.Schema.const("relationship").description("\u5173\u7CFB"),
    import_koishi4.Schema.const("userAlias").description("\u81EA\u5B9A\u4E49\u6635\u79F0")
  ])
).role("checkbox").extra("default", void 0).description("\u9009\u62E9\u8981\u6CE8\u518C\u5230 ChatLuna \u7684\u539F\u751F\u5DE5\u5177\u3002\u5F53\u5F53\u524D\u73AF\u5883\u53EA\u6709\u4E00\u4E2A`scopeId`\u65F6\uFF0C\u5DF2\u9009\u5DE5\u5177\u4F1A\u81EA\u52A8\u6CE8\u5165\u5E76\u7ED1\u5B9A\u8BE5`scopeId`\uFF0C\u6A21\u578B\u65E0\u9700\u586B\u5199");
var NativeToolSettingsSchema = import_koishi4.Schema.object({
  nativeToolSettings: import_koishi4.Schema.object({
    enabledNativeTools: EnabledNativeToolsSchema,
    affinity: import_koishi4.Schema.object({
      toolName: import_koishi4.Schema.string().default("affinity_affinity").description("\u5DE5\u5177\u540D\u79F0"),
      description: import_koishi4.Schema.string().default(DEFAULT_AFFINITY_NATIVE_TOOL_DESCRIPTION).description("\u5DE5\u5177\u63CF\u8FF0")
    }).description("\u597D\u611F\u5EA6\u5DE5\u5177").collapse(),
    blacklist: import_koishi4.Schema.object({
      toolName: import_koishi4.Schema.string().default("affinity_blacklist").description("\u5DE5\u5177\u540D\u79F0"),
      description: import_koishi4.Schema.string().default(DEFAULT_BLACKLIST_NATIVE_TOOL_DESCRIPTION).description("\u5DE5\u5177\u63CF\u8FF0")
    }).description("\u9ED1\u540D\u5355\u5DE5\u5177").collapse(),
    relationship: import_koishi4.Schema.object({
      toolName: import_koishi4.Schema.string().default("affinity_relationship").description("\u5DE5\u5177\u540D\u79F0"),
      description: import_koishi4.Schema.string().default(DEFAULT_RELATIONSHIP_NATIVE_TOOL_DESCRIPTION).description("\u5DE5\u5177\u63CF\u8FF0")
    }).description("\u5173\u7CFB\u5DE5\u5177").collapse(),
    userAlias: import_koishi4.Schema.object({
      toolName: import_koishi4.Schema.string().default("affinity_user_alias").description("\u5DE5\u5177\u540D\u79F0"),
      description: import_koishi4.Schema.string().default(DEFAULT_USER_ALIAS_NATIVE_TOOL_DESCRIPTION).description("\u5DE5\u5177\u63CF\u8FF0")
    }).description("\u81EA\u5B9A\u4E49\u6635\u79F0\u5DE5\u5177").collapse()
  }).description("")
}).description("\u539F\u751F\u5DE5\u5177\u8BBE\u7F6E");
var XmlToolSettingsSchema = import_koishi4.Schema.object({
  injectXmlToolAsReplyTool: import_koishi4.Schema.boolean().default(false).description(
    "\u5C06 XML \u5DE5\u5177\u6539\u4E3A\u6CE8\u5165\u5B9E\u9A8C\u6027[\u5DE5\u5177\u8C03\u7528\u56DE\u590D](https://chatluna.chat/ecosystem/other/character.html#%E9%A2%84%E8%AE%BE)\u7684\u53C2\u6570\u4E2D\u3002\u5F53\u524D\u73AF\u5883\u53EA\u6709\u4E00\u4E2A`scopeId`\u65F6\uFF0C\u4F1A\u81EA\u52A8\u6CE8\u5165\u5E76\u7ED1\u5B9A\u8BE5`scopeId`\uFF0C\u6A21\u578B\u65E0\u9700\u586B\u5199"
  ),
  enableAffinityXmlToolCall: import_koishi4.Schema.boolean().default(true).description("\u542F\u7528\u597D\u611F\u5EA6 XML \u5DE5\u5177\u8C03\u7528"),
  enableBlacklistXmlToolCall: import_koishi4.Schema.boolean().default(true).description("\u542F\u7528\u9ED1\u540D\u5355 XML \u5DE5\u5177\u8C03\u7528"),
  enableRelationshipXmlToolCall: import_koishi4.Schema.boolean().default(true).description("\u542F\u7528\u5173\u7CFB XML \u5DE5\u5177\u8C03\u7528"),
  enableUserAliasXmlToolCall: import_koishi4.Schema.boolean().default(true).description("\u542F\u7528\u81EA\u5B9A\u4E49\u6635\u79F0 XML \u5DE5\u5177\u8C03\u7528"),
  autoInjectReferencePrompt: import_koishi4.Schema.boolean().default(false).description(
    "\u81EA\u52A8\u5C06\u4E0B\u65B9 XML \u53C2\u8003\u63D0\u793A\u8BCD\u4F5C\u4E3A\u7CFB\u7EDF\u63D0\u793A\u8BCD\u6CE8\u5165\u6A21\u578B\u3002\u5F53\u524D\u73AF\u5883\u53EA\u6709\u4E00\u4E2A`scopeId`\u65F6\uFF0C\u4F1A\u5C06`{scopeId}`\u66FF\u6362\u4E3A\u5F53\u524D\u4F5C\u7528\u57DF\uFF1B\u5B58\u5728\u591A\u4E2A`scopeId`\u65F6\u4FDD\u7559\u5360\u4F4D\u7B26\uFF0C\u9700\u81EA\u884C\u4FEE\u6539\u3002\u542F\u7528\u4E0A\u65B9\u5B9E\u9A8C\u6027\u5DE5\u5177\u8C03\u7528\u56DE\u590D\u540E\uFF0C\u6B64\u9009\u9879\u4E0D\u751F\u6548"
  ),
  characterPromptTemplate: import_koishi4.Schema.string().role("textarea").default(
    `<available_actions>

Use an independent \`<actions>\` element only when a non-verbal system action is needed. Omit it otherwise.

Available actions:

\`<affinity scopeId="{scopeId}" userId="user_id" action="action" delta="delta"/>\`
Update a user's affinity.

scopeId: \`{scopeId}\`
userId: target user ID
action: \`increase\` or \`decrease\`
delta: required positive integer

\`<blacklist scopeId="{scopeId}" userId="user_id" action="action" mode="mode" durationHours="hours" note="note"/>\`
Manage a user's blacklist status.

scopeId: \`{scopeId}\`
userId: target user ID
action: \`add\` or \`remove\`
mode: \`permanent\` or \`temporary\`
durationHours: only include when \`action="add"\` and \`mode="temporary"\`
note: optional

\`<relationship scopeId="{scopeId}" userId="user_id" action="action" relation="relation"/>\`
Adjust a user's relationship.

scopeId: \`{scopeId}\`
userId: target user ID
action: \`set\` or \`clear\`
relation: only include when \`action="set"\`

\`<userAlias scopeId="{scopeId}" userId="user_id" name="name"/>\`
Set a custom nickname for a user.

scopeId: \`{scopeId}\`
userId: target user ID
name: custom nickname

Actions must be placed inside a single \`<actions>\` element:

\`\`\`xml
<actions>
  <affinity scopeId="{scopeId}" userId="123456" action="increase" delta="5"/>
  <blacklist scopeId="{scopeId}" userId="123456" action="add" mode="permanent" note="violation"/>
  <blacklist scopeId="{scopeId}" userId="123456" action="add" mode="temporary" durationHours="12" note="spam"/>
  <relationship scopeId="{scopeId}" userId="123456" action="set" relation="\u5C0F\u7965\u59D0\u59D0"/>
  <userAlias scopeId="{scopeId}" userId="123456" name="\u5C0F\u7965"/>
</actions>
\`\`\`

Only include actions that should actually be executed. Omit fields that are not applicable. Do not describe or simulate actions inside \`<actions>\`.

</available_actions>`
  ).description("\u6A21\u578B\u56DE\u590D XML \u53C2\u8003\u63D0\u793A\u8BCD\uFF0C\u9ED8\u8BA4\u9700\u624B\u52A8\u66FF\u6362`{scopeId}`\u5E76\u5199\u5165\u89D2\u8272\u63D0\u793A\u8BCD\uFF1B\u5F00\u542F\u4E0A\u65B9\u81EA\u52A8\u6CE8\u5165\u540E\u65E0\u9700\u624B\u52A8\u5199\u5165\uFF0C\u5355\u4E00`scopeId`\u65F6\u8FD8\u4F1A\u81EA\u52A8\u66FF\u6362\u5360\u4F4D\u7B26\uFF0C\u591A`scopeId`\u65F6\u9700\u5728\u6A21\u677F\u4E2D\u81EA\u884C\u6539\u4E3A\u76EE\u6807\u4F5C\u7528\u57DF\u3002\u82E5\u5F00\u542F\u5B9E\u9A8C\u6027\u5DE5\u5177\u8C03\u7528\u56DE\u590D\uFF0C\u5219\u65E0\u9700\u589E\u52A0\u989D\u5916 XML \u63D0\u793A\u8BCD").collapse()
}).description("Character XML \u5DE5\u5177\u8BBE\u7F6E");
var VariableSettingsSchema = import_koishi4.Schema.object({
  affinityVariableName: import_koishi4.Schema.string().default("affinity").description(
    '\u597D\u611F\u5EA6\u53D8\u91CF\u540D\u79F0\uFF0C\u8C03\u7528\u793A\u4F8B\uFF1A{affinity("scopeId")}\uFF0C\u8BF7\u5C06 scopeId \u66FF\u6362\u4E3A\u4F60\u8BBE\u5B9A\u7684\u5B9E\u9645 scopeId\u3002\u8FD4\u56DE\u683C\u5F0F\u4E3A\u6587\u672C\u884C\uFF0C\u5305\u542B id\u3001name\u3001nickname\u3001affinity\u3001relationship\u3001chatcount\uFF1B\u5F53\u5C55\u793A\u8303\u56F4\u5927\u4E8E 1 \u65F6\u4F1A\u8FD4\u56DE\u591A\u884C\u3002'
  ),
  showChatCountInAffinityVariable: import_koishi4.Schema.boolean().default(true).description("\u5728\u597D\u611F\u5EA6\u53D8\u91CF\u4E2D\u663E\u793A\u5BF9\u8BDD\u6B21\u6570 chatcount"),
  affinityDisplayRange: import_koishi4.Schema.number().default(1).min(1).step(1).description("\u663E\u793A\u5F53\u524D\u4E0A\u4E0B\u6587\u4E2D\u591A\u5C11\u4F4D\u7528\u6237\u7684\u597D\u611F\u5EA6\u4FE1\u606F"),
  relationshipLevelVariableName: import_koishi4.Schema.string().default("relationshipLevel").description(
    '\u597D\u611F\u5EA6\u533A\u95F4\u53D8\u91CF\u540D\u79F0\uFF0C\u8C03\u7528\u793A\u4F8B\uFF1A{relationshipLevel("scopeId")}\uFF0C\u8BF7\u5C06 scopeId \u66FF\u6362\u4E3A\u4F60\u8BBE\u5B9A\u7684\u5B9E\u9645 scopeId\u3002\u8FD4\u56DE\u683C\u5F0F\u4E3A\u6587\u672C\u884C\uFF0C\u5217\u51FA\u5F53\u524D\u914D\u7F6E\u4E2D\u7684\u6240\u6709\u533A\u95F4\uFF0C\u5305\u542B min\u3001max\u3001relationship\u3001note\u3002'
  ),
  blacklistListVariableName: import_koishi4.Schema.string().default("blacklistList").description(
    '\u5F53\u524D\u7FA4\u9ED1\u540D\u5355\u5217\u8868\u53D8\u91CF\u540D\u79F0\uFF0C\u8C03\u7528\u793A\u4F8B\uFF1A{blacklistList("scopeId")}\uFF0C\u8BF7\u5C06 scopeId \u66FF\u6362\u4E3A\u4F60\u8BBE\u5B9A\u7684\u5B9E\u9645 scopeId\u3002\u8FD4\u56DE\u683C\u5F0F\u4E3A\u6587\u672C\u884C\uFF0C\u5217\u51FA\u5F53\u524D\u7FA4\u547D\u4E2D\u7684\u9ED1\u540D\u5355\u8BB0\u5F55\uFF0C\u5305\u542B id\u3001name\u3001affinity\u3001mode\u3001blockedAt\uFF1B\u4E34\u65F6\u9ED1\u540D\u5355\u989D\u5916\u5305\u542B expiresAt\u3002'
  )
}).description("\u53D8\u91CF\u8BBE\u7F6E");
var OtherSettingsSchema = import_koishi4.Schema.object({
  enableDashboard: import_koishi4.Schema.boolean().default(true).description("\u5728 Koishi \u63A7\u5236\u53F0\u4FA7\u680F\u663E\u793A\u597D\u611F\u5EA6\u4EEA\u8868\u76D8"),
  rankRenderAsImage: import_koishi4.Schema.boolean().default(false).description("\u5C06\u597D\u611F\u5EA6\u6392\u884C\u6E32\u67D3\u4E3A\u56FE\u7247"),
  blacklistRenderAsImage: import_koishi4.Schema.boolean().default(false).description("\u5C06\u9ED1\u540D\u5355\u6E32\u67D3\u4E3A\u56FE\u7247"),
  shortTermBlacklistRenderAsImage: import_koishi4.Schema.boolean().default(false).description("\u5C06\u4E34\u65F6\u9ED1\u540D\u5355\u6E32\u67D3\u4E3A\u56FE\u7247"),
  inspectRenderAsImage: import_koishi4.Schema.boolean().default(false).description("\u5C06\u597D\u611F\u5EA6\u8BE6\u60C5\u6E32\u67D3\u4E3A\u56FE\u7247"),
  inspectShowImpression: import_koishi4.Schema.boolean().default(true).description("\u5728\u597D\u611F\u5EA6\u8BE6\u60C5\u4E2D\u663E\u793A\u5370\u8C61\uFF08\u4F9D\u8D56 chatluna-group-analysis\uFF09"),
  debugLogging: import_koishi4.Schema.boolean().default(false).description("\u8F93\u51FA\u8C03\u8BD5\u65E5\u5FD7")
}).description("\u5176\u4ED6\u8BBE\u7F6E");

// src/schema/index.ts
var name = "chatluna-affinity";
var inject = {
  required: ["chatluna", "database"],
  optional: [
    "console",
    "chatluna_group_analysis",
    "chatluna_character"
  ]
};
var ConfigSchema = import_koishi5.Schema.intersect([
  ScopeSettingsSchema,
  AffinitySchema,
  BlacklistSchema,
  RelationshipSchema,
  VariableSettingsSchema,
  NativeToolSettingsSchema,
  XmlToolSettingsSchema,
  OtherSettingsSchema
]);

// src/plugin.ts
var path = __toESM(require("path"));

// src/models/affinity.ts
var MODEL_NAME = "chatluna_affinity";
var MODEL_NAME_V2 = "chatluna_affinity_v2";
function extendAffinityModel(ctx) {
  ctx.model.extend(
    MODEL_NAME,
    {
      userId: { type: "string", length: 64 },
      nickname: { type: "string", length: 255, nullable: true },
      affinity: { type: "integer", initial: 0 },
      relation: { type: "string", length: 64, nullable: true },
      specialRelation: { type: "string", length: 64, nullable: true },
      shortTermAffinity: { type: "integer", nullable: true },
      longTermAffinity: { type: "integer", nullable: true },
      chatCount: { type: "integer", nullable: true },
      actionStats: { type: "text", nullable: true },
      lastInteractionAt: { type: "timestamp", nullable: true },
      coefficientState: { type: "text", nullable: true }
    },
    { primary: ["userId"] }
  );
  ctx.model.extend(
    MODEL_NAME_V2,
    {
      scopeId: { type: "string", length: 32 },
      userId: { type: "string", length: 64 },
      nickname: { type: "string", length: 255, nullable: true },
      affinity: { type: "integer", initial: 0 },
      relation: { type: "string", length: 64, nullable: true },
      specialRelation: { type: "string", length: 64, nullable: true },
      shortTermAffinity: { type: "integer", nullable: true },
      longTermAffinity: { type: "integer", nullable: true },
      chatCount: { type: "integer", nullable: true },
      actionStats: { type: "text", nullable: true },
      lastInteractionAt: { type: "timestamp", nullable: true },
      coefficientState: { type: "text", nullable: true }
    },
    { primary: ["scopeId", "userId"] }
  );
}

// src/models/blacklist.ts
var BLACKLIST_MODEL_NAME = "chatluna_blacklist";
var BLACKLIST_MODEL_NAME_V2 = "chatluna_blacklist_v2";
function extendBlacklistModel(ctx) {
  ctx.model.extend(
    BLACKLIST_MODEL_NAME,
    {
      platform: { type: "string", length: 64 },
      userId: { type: "string", length: 64 },
      mode: { type: "string", length: 16 },
      blockedAt: { type: "timestamp" },
      expiresAt: { type: "timestamp", nullable: true },
      nickname: { type: "string", length: 255, nullable: true },
      note: { type: "string", length: 255, nullable: true },
      durationHours: { type: "integer", nullable: true },
      penalty: { type: "integer", nullable: true }
    },
    { primary: ["userId", "mode"] }
  );
  ctx.model.extend(
    BLACKLIST_MODEL_NAME_V2,
    {
      scopeId: { type: "string", length: 32 },
      platform: { type: "string", length: 64 },
      userId: { type: "string", length: 64 },
      mode: { type: "string", length: 16 },
      blockedAt: { type: "timestamp" },
      expiresAt: { type: "timestamp", nullable: true },
      nickname: { type: "string", length: 255, nullable: true },
      note: { type: "string", length: 255, nullable: true },
      durationHours: { type: "integer", nullable: true },
      penalty: { type: "integer", nullable: true }
    },
    { primary: ["scopeId", "userId", "mode"] }
  );
}

// src/models/user-alias.ts
var USER_ALIAS_MODEL_NAME = "chatluna_user_alias";
var USER_ALIAS_MODEL_NAME_V2 = "chatluna_user_alias_v2";
function extendUserAliasModel(ctx) {
  ctx.model.extend(
    USER_ALIAS_MODEL_NAME,
    {
      platform: { type: "string", length: 64 },
      userId: { type: "string", length: 64 },
      alias: { type: "string", length: 255 },
      updatedAt: { type: "timestamp" }
    },
    { primary: ["platform", "userId"] }
  );
  ctx.model.extend(
    USER_ALIAS_MODEL_NAME_V2,
    {
      scopeId: { type: "string", length: 32 },
      platform: { type: "string", length: 64 },
      userId: { type: "string", length: 64 },
      alias: { type: "string", length: 255 },
      updatedAt: { type: "timestamp" }
    },
    { primary: ["scopeId", "userId"] }
  );
}

// src/models/migration.ts
var MIGRATION_MODEL_NAME = "chatluna_affinity_migrations";
function extendMigrationModel(ctx) {
  ctx.model.extend(
    MIGRATION_MODEL_NAME,
    {
      scopeId: { type: "string", length: 32 },
      version: { type: "string", length: 32 },
      migratedAt: { type: "timestamp" },
      status: { type: "string", length: 32 }
    },
    { primary: ["scopeId", "version"] }
  );
}

// src/models/dashboard-snapshot.ts
var DASHBOARD_SNAPSHOT_MODEL_NAME = "chatluna_affinity_dashboard_snapshot";
var USER_AFFINITY_SNAPSHOT_MODEL_NAME = "chatluna_affinity_user_snapshot";
function extendDashboardSnapshotModel(ctx) {
  ctx.model.extend(
    DASHBOARD_SNAPSHOT_MODEL_NAME,
    {
      scopeId: { type: "string", length: 32 },
      date: { type: "string", length: 10 },
      recordedAt: { type: "timestamp" },
      generatedBy: { type: "string", length: 32, nullable: true },
      users: { type: "integer", initial: 0 },
      affinityTotal: { type: "integer", initial: 0 },
      longTermAffinityTotal: { type: "integer", initial: 0 },
      shortTermAffinityTotal: { type: "integer", initial: 0 },
      chatCount: { type: "integer", initial: 0 },
      blacklisted: { type: "integer", initial: 0 },
      permanentBlacklisted: { type: "integer", initial: 0 },
      temporaryBlacklisted: { type: "integer", initial: 0 },
      aliases: { type: "integer", initial: 0 },
      latestInteractionAt: { type: "timestamp", nullable: true }
    },
    { primary: ["scopeId", "date"] }
  );
  ctx.model.extend(
    USER_AFFINITY_SNAPSHOT_MODEL_NAME,
    {
      scopeId: { type: "string", length: 32 },
      userId: { type: "string", length: 64 },
      date: { type: "string", length: 10 },
      recordedAt: { type: "timestamp" },
      nickname: { type: "string", length: 255, nullable: true },
      affinity: { type: "integer", initial: 0 },
      longTermAffinity: { type: "integer", initial: 0 },
      shortTermAffinity: { type: "integer", initial: 0 },
      chatCount: { type: "integer", initial: 0 },
      relation: { type: "string", length: 64, nullable: true },
      specialRelation: { type: "string", length: 64, nullable: true },
      lastInteractionAt: { type: "timestamp", nullable: true }
    },
    { primary: ["scopeId", "userId", "date"] }
  );
}

// src/models/index.ts
function registerModels(ctx) {
  extendAffinityModel(ctx);
  extendBlacklistModel(ctx);
  extendUserAliasModel(ctx);
  extendMigrationModel(ctx);
  extendDashboardSnapshotModel(ctx);
}

// src/helpers/logger.ts
function createLogger(ctx, config) {
  const base = ctx.logger ? ctx.logger("chatluna-affinity") : console;
  return (level, message, detail) => {
    if (!config.debugLogging && level === "debug") return;
    const writer = typeof base?.[level] === "function" ? base[level] : base?.info ?? base?.log ?? console.log;
    if (detail === void 0) {
      writer.call(base, message);
    } else {
      writer.call(base, message, detail);
    }
  };
}

// src/helpers/session.ts
function getChannelId(session) {
  if (!session) return "";
  const s = session;
  return s.guildId || s.groupId || s.channelId || s.event?.guild?.id || s.event?.group?.id || s.event?.channel?.id || s.roomId || "";
}
function getGuildId(session) {
  if (!session) return "";
  const s = session;
  return s.guildId || s.event?.guild?.id || "";
}
function getPlatform(session) {
  if (!session) return "";
  const s = session;
  return s.platform || s.event?.platform || s.bot?.platform || "";
}
function getUserId(session) {
  if (!session) return "";
  const s = session;
  return s.userId || s.event?.user?.id || "";
}
function getSelfId(session) {
  if (!session) return "";
  const s = session;
  return s.selfId || s.event?.selfId || s.bot?.selfId || "";
}
function makeUserKey(platform, userId) {
  return `${platform || "unknown"}:${userId || "anonymous"}`;
}

// src/helpers/scope.ts
var SCOPE_ID_PATTERN = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,32}$/;
function normalizeScopeId(value) {
  return String(value || "").trim();
}
function isValidScopeId(value) {
  return SCOPE_ID_PATTERN.test(value);
}
function assertScopeId(value) {
  const scopeId = normalizeScopeId(value);
  if (!scopeId) {
    throw new Error("scopeId \u4E0D\u80FD\u4E3A\u7A7A");
  }
  if (!isValidScopeId(scopeId)) {
    throw new Error(
      "scopeId \u975E\u6CD5\uFF0C\u53EA\u5141\u8BB8\u4E2D\u6587\u3001\u82F1\u6587\u3001\u6570\u5B57\u3001_\u3001-\uFF0C\u957F\u5EA6 1-32\uFF0C\u4E14\u4E0D\u80FD\u5305\u542B . \u6216\u7A7A\u767D"
    );
  }
  return scopeId;
}
function buildScopedCommandName(scopeId, suffix) {
  return `${scopeId}.${suffix}`;
}
function resolveScopedVariableArgs(args) {
  const normalizedArgs = Array.isArray(args) ? args : args === void 0 ? [] : [args];
  const [scopeArg, userArg] = normalizedArgs;
  const scopeId = normalizeScopeId(scopeArg);
  if (!scopeId) return null;
  return {
    scopeId,
    targetUserId: String(userArg || "").trim()
  };
}

// src/helpers/role-mapper.ts
function translateRole(value) {
  if (value == null) return { role: "\u7FA4\u5458", matched: false, raw: value };
  if (Array.isArray(value)) {
    let fallback = { role: "\u7FA4\u5458", matched: false, raw: void 0 };
    for (const item of value) {
      const candidate = translateRole(item);
      if (candidate.matched) return candidate;
      if (candidate.raw !== void 0 && fallback.raw === void 0) {
        fallback = candidate;
      }
    }
    return fallback;
  }
  if (typeof value === "object") {
    const keys = [
      "role",
      "roleName",
      "permission",
      "permissions",
      "title",
      "identity",
      "type",
      "level",
      "status",
      "roles"
    ];
    let fallback = { role: "\u7FA4\u5458", matched: false, raw: void 0 };
    for (const key of keys) {
      if (!(key in value)) continue;
      const candidate = translateRole(
        value[key]
      );
      if (candidate.matched) return candidate;
      if (candidate.raw !== void 0 && fallback.raw === void 0) {
        fallback = candidate;
      }
    }
    return fallback;
  }
  const text = String(value).trim();
  if (!text) return { role: "\u7FA4\u5458", matched: false, raw: text };
  const lower = text.toLowerCase();
  if (ROLE_MAPPING.direct[text]) {
    return { role: ROLE_MAPPING.direct[text], matched: true, raw: text };
  }
  if (ROLE_MAPPING.direct[lower]) {
    return { role: ROLE_MAPPING.direct[lower], matched: true, raw: text };
  }
  if (/^\d+$/.test(text)) {
    const mapped = ROLE_MAPPING.numeric[text];
    if (mapped) return { role: mapped, matched: true, raw: text };
  }
  for (const [roleType, keywords] of Object.entries(ROLE_MAPPING.keywords)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        const role = roleType === "owner" ? "\u7FA4\u4E3B" : roleType === "admin" ? "\u7BA1\u7406\u5458" : "\u7FA4\u5458";
        return { role, matched: true, raw: text };
      }
    }
  }
  if (text.includes("\u7FA4\u4E3B") || text.includes("\u623F\u4E3B") || text.includes("\u4F1A\u957F") || text.includes("\u56E2\u957F")) {
    return { role: "\u7FA4\u4E3B", matched: true, raw: text };
  }
  if (text.includes("\u7BA1\u7406\u5458") || text.includes("\u7BA1\u7406")) {
    return { role: "\u7BA1\u7406\u5458", matched: true, raw: text };
  }
  if (text.includes("\u7FA4\u5458") || text.includes("\u6210\u5458") || text.includes("\u666E\u901A")) {
    return { role: "\u7FA4\u5458", matched: true, raw: text };
  }
  return { role: "\u7FA4\u5458", matched: false, raw: text };
}
function collectRoleCandidates(session, member) {
  const candidates = [];
  const visit = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object") {
      const keys = [
        "role",
        "roleName",
        "permission",
        "permissions",
        "title",
        "identity",
        "type",
        "level",
        "status",
        "roles"
      ];
      for (const key of keys) {
        if (key in value) {
          visit(value[key]);
        }
      }
      return;
    }
    candidates.push(value);
  };
  visit(member);
  visit(session?.member);
  visit(session?.author);
  visit(session?.event?.member);
  visit(session?.event?.sender);
  visit(session?.event?.operator);
  visit(session?.payload?.sender);
  visit(session?.user);
  visit(session?.self);
  visit(session?.bot?.user);
  visit(session?.event?.self);
  visit(session?.event?.bot);
  return candidates;
}
function resolveRoleLabel(session, member, options = {}) {
  const { logUnknown = false, logger } = options;
  const unknownRoles = /* @__PURE__ */ new Set();
  const candidates = collectRoleCandidates(session, member);
  for (const candidate of candidates) {
    const { role, matched, raw } = translateRole(candidate);
    if (matched) return role;
    if (logUnknown && raw !== void 0 && raw !== null && raw !== "" && !unknownRoles.has(String(raw))) {
      unknownRoles.add(String(raw));
      if (typeof logger === "function") {
        logger("debug", "\u672A\u8BC6\u522B\u7684\u7FA4\u8EAB\u4EFD", { raw });
      }
    }
  }
  return "\u7FA4\u5458";
}
function getRoleDisplay(role) {
  const normalized = translateRole(role);
  return normalized.role;
}

// src/utils/math.ts
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function clampFloat(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// src/utils/time.ts
function pad(n) {
  return String(n).padStart(2, "0");
}
function normalizeTimestamp(value) {
  if (!value) return null;
  const ts = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(ts)) return null;
  return ts < TIME_CONSTANTS.SECONDS_THRESHOLD ? ts * 1e3 : ts;
}
function formatTimestamp(value) {
  if (!value) return "";
  const ts = value instanceof Date ? value.getTime() : typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts < TIME_CONSTANTS.SECONDS_THRESHOLD ? ts * 1e3 : ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}
function formatBeijingTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}
function formatDateOnly(value) {
  if (!value) return "";
  const ts = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts < TIME_CONSTANTS.SECONDS_THRESHOLD ? ts * 1e3 : ts);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function formatDateTime(value) {
  if (!value) return "";
  const ts = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts < TIME_CONSTANTS.SECONDS_THRESHOLD ? ts * 1e3 : ts);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date?.valueOf()) ? null : date;
}
function dayNumber(date) {
  return Math.floor(date.getTime() / TIME_CONSTANTS.MS_PER_DAY);
}
function getDateString(date, timezone = "Asia/Shanghai") {
  return date.toLocaleDateString("zh-CN", { timeZone: timezone });
}
function getTimeString(date, timezone = "Asia/Shanghai") {
  return date.toLocaleTimeString("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit"
  });
}

// src/utils/string.ts
function stripAtPrefix(text) {
  const value = String(text ?? "").trim();
  if (!value) return "";
  const mentionMatch = value.match(/^<@!?(.+)>$/);
  if (mentionMatch) return mentionMatch[1];
  const decoded = value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const atTagMatch = decoded.match(
    /<at\s+[^>]*(?:id|qq)\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/i
  );
  if (atTagMatch) return atTagMatch[1];
  return value.replace(/^[@＠]+/, "").trim() || decoded;
}
function sanitizeChannel(value) {
  return String(value ?? "").trim();
}
function pickFirst(...values) {
  for (const value of values) {
    if (value !== void 0 && value !== null && value !== "") {
      return value;
    }
  }
  return void 0;
}
function truncate(text, maxLength, suffix = "...") {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length) + suffix;
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// src/utils/template.ts
function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    return key in vars ? String(vars[key]) : `{${key}}`;
  });
}

// src/helpers/member.ts
function translateGender(value) {
  if (value == null) return "";
  const text = String(value).trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (["male", "man", "m", "1", "boy"].includes(lower)) return "\u7537";
  if (["female", "woman", "f", "2", "girl"].includes(lower)) return "\u5973";
  if (["\u672A\u77E5", "unknown", "0", "secret"].includes(lower)) return "";
  return text;
}
function collectNicknameCandidates(member, userId, fallbackNames = []) {
  const candidates = [
    member?.card,
    member?.remark,
    member?.displayName,
    member?.nick,
    member?.nickname,
    member?.name,
    member?.user?.nickname,
    member?.user?.name,
    ...fallbackNames,
    userId
  ];
  return candidates.filter((v) => Boolean(v));
}
function renderInfoField(fieldName, member, session, options) {
  const { userId, log } = options;
  switch (fieldName) {
    case "nickname": {
      const nameCandidates = collectNicknameCandidates(
        member,
        userId,
        options.fallbackNames
      );
      const name2 = stripAtPrefix(nameCandidates[0] || "");
      return name2 ? `name:${name2}` : null;
    }
    case "userId":
      return userId ? `id:${userId}` : null;
    case "role": {
      const roleLabel = resolveRoleLabel(session, member, {
        logUnknown: options.logUnknown,
        logger: log
      }) || "\u7FA4\u5458";
      return `\u7FA4\u5185\u8EAB\u4EFD:${roleLabel}`;
    }
    case "level": {
      const level = pickFirst(
        member?.level,
        member?.levelName,
        member?.level_name,
        member?.level_info?.current_level,
        member?.level_info?.level
      );
      return level !== void 0 && level !== null && level !== "" ? `\u7FA4\u7B49\u7EA7:${level}` : null;
    }
    case "title": {
      const title = pickFirst(
        member?.title,
        member?.specialTitle,
        member?.special_title
      );
      return title ? `\u5934\u8854:${title}` : null;
    }
    case "gender": {
      const gender = translateGender(member?.sex ?? member?.gender ?? "");
      return gender ? `\u6027\u522B:${gender}` : null;
    }
    case "age": {
      const age = Number(member?.age);
      return Number.isFinite(age) && age > 0 ? `\u5E74\u9F84:${age}` : null;
    }
    case "area": {
      const area = pickFirst(member?.area, member?.region, member?.location);
      return area ? `\u5730\u533A:${area}` : null;
    }
    case "joinTime": {
      const ts = normalizeTimestamp(
        pickFirst(
          member?.join_time,
          member?.joined_at,
          member?.joinTime,
          member?.joinedAt,
          member?.joinTimestamp
        )
      );
      const formatted = formatDateOnly(ts);
      return formatted ? `\u5165\u7FA4:${formatted}` : null;
    }
    case "lastSentTime": {
      const ts = normalizeTimestamp(
        pickFirst(
          member?.last_sent_time,
          member?.lastSentTime,
          member?.lastSpeakTimestamp
        )
      );
      const formatted = formatDateTime(ts);
      return formatted ? `\u6D3B\u8DC3:${formatted}` : null;
    }
    case "chatCount": {
      const rawCount = options.chatCount;
      const numeric = Number(rawCount);
      if (!Number.isFinite(numeric)) return null;
      return `\u4E92\u52A8\u6B21\u6570:${Math.max(0, Math.round(numeric))}`;
    }
    default:
      return null;
  }
}
var DEFAULT_ITEMS = [
  "nickname",
  "userId",
  "role",
  "level",
  "title",
  "gender",
  "age",
  "area",
  "joinTime",
  "lastSentTime"
];
function renderMemberInfo(session, member, userId, configItems, options = {}) {
  const {
    fallbackNames = [],
    defaultItems = DEFAULT_ITEMS,
    logUnknown = false,
    log
  } = options;
  const items = [];
  const configuredItems = Array.isArray(configItems) && configItems.length ? configItems : defaultItems;
  for (const item of configuredItems) {
    const key = String(item || "").trim();
    if (!key || items.includes(key)) continue;
    items.push(key);
  }
  if (!items.length) items.push("nickname", "userId");
  const parts = [];
  for (const item of items) {
    const rendered = renderInfoField(item, member, session, {
      userId,
      fallbackNames,
      logUnknown,
      log,
      chatCount: options.chatCount
    });
    if (rendered) parts.push(rendered);
  }
  if (!parts.length) return userId ? `id:${userId}` : "\u672A\u77E5\u7528\u6237";
  return parts.join(", ");
}
async function resolveUserInfo(session, configItems, fetchMemberFn, options = {}) {
  const userId = stripAtPrefix(session.userId || "");
  const candidates = [
    userId ? await fetchMemberFn(session, userId) : null,
    session?.member,
    session?.author,
    session?.event?.member,
    session?.event?.sender,
    session?.payload?.sender
  ].filter(Boolean);
  const member = candidates[0] || null;
  return renderMemberInfo(session, member, userId, configItems, {
    ...options,
    fallbackNames: [session.username].filter((v) => Boolean(v))
  });
}
async function resolveBotInfo(session, configItems, fetchMemberFn, options = {}) {
  const botId = stripAtPrefix(
    session.selfId || session.bot?.selfId || ""
  );
  const candidates = [
    botId ? await fetchMemberFn(session, botId) : null,
    session?.self,
    session?.bot?.user,
    session?.event?.self,
    session?.event?.bot
  ].filter(Boolean);
  const member = candidates[0] || null;
  const fallbacks = [
    session?.self?.nickname,
    session?.self?.name,
    session?.bot?.nickname,
    session?.bot?.name
  ].filter((v) => Boolean(v));
  return renderMemberInfo(session, member, botId, configItems, {
    ...options,
    fallbackNames: fallbacks
  });
}
async function fetchMember(session, userId) {
  try {
    const guildId = session.guildId || session?.event?.guild?.id;
    if (!guildId) return null;
    const bot = session.bot;
    if (!bot) return null;
    if (session.platform === "onebot") {
      const internal = bot?.internal;
      if (internal) {
        if (typeof internal.getGroupMemberInfo === "function") {
          const result = await internal.getGroupMemberInfo(Number(guildId), Number(userId), false);
          if (result) return result;
        } else if (typeof internal._request === "function") {
          const result = await internal._request("get_group_member_info", {
            group_id: Number(guildId),
            user_id: Number(userId),
            no_cache: false
          });
          if (result) return result;
        }
      }
    }
    if (typeof bot.getGuildMember === "function") {
      const member = await bot.getGuildMember(guildId, userId);
      return member;
    }
    return null;
  } catch {
    return null;
  }
}
async function resolveUserIdentity(session, input) {
  const stripped = stripAtPrefix(input);
  if (!stripped) return null;
  if (/^\d+$/.test(stripped)) {
    const member = await fetchMember(session, stripped);
    const nickname = collectNicknameCandidates(member, stripped)[0] || stripped;
    return { userId: stripped, nickname };
  }
  return null;
}
async function findMemberByName(session, name2, log) {
  const searchName = name2.trim().toLowerCase();
  if (!searchName) return null;
  try {
    const guildId = session.guildId || session?.event?.guild?.id;
    if (!guildId) return null;
    const bot = session.bot;
    if (!bot || typeof bot.getGuildMemberList !== "function") return null;
    const list = await bot.getGuildMemberList(guildId);
    if (!list?.data) return null;
    for (const member of list.data) {
      const info = member;
      const candidates = collectNicknameCandidates(
        info,
        info.userId || info.id || ""
      );
      for (const candidate of candidates) {
        if (candidate.toLowerCase().includes(searchName)) {
          const userId = info.userId || info.id || info.qq || info.uid || "";
          return { userId, nickname: candidates[0] || userId };
        }
      }
    }
  } catch (error) {
    log?.("debug", "\u67E5\u627E\u6210\u5458\u5931\u8D25", error);
  }
  return null;
}
function resolveGroupId(session) {
  if (session.isDirect) {
    return "";
  }
  return String(
    session.guildId || session?.groupId || session.channelId || session?.roomId || ""
  ).trim();
}
async function fetchGroupMemberIds(session, log) {
  try {
    const guildId = resolveGroupId(session);
    if (!guildId) return null;
    const bot = session.bot;
    if (!bot) return null;
    const ids = /* @__PURE__ */ new Set();
    const internal = bot?.internal;
    if (internal) {
      let members = null;
      if (typeof internal.getGroupMemberList === "function") {
        members = await internal.getGroupMemberList(guildId);
      } else if (typeof internal._request === "function") {
        members = await internal._request("get_group_member_list", { group_id: Number(guildId) });
      }
      if (Array.isArray(members) && members.length > 0) {
        for (const member of members) {
          const userId = String(
            member.user_id || member.userId || member.id || member.qq || member.uid || ""
          );
          if (userId) ids.add(userId);
        }
        return ids;
      }
    }
    if (typeof bot.getGuildMemberList === "function") {
      const list = await bot.getGuildMemberList(guildId);
      if (list?.data) {
        for (const member of list.data) {
          const info = member;
          const userId = info.userId || info.id || info.qq || info.uid || "";
          if (userId) ids.add(userId);
        }
        return ids;
      }
    }
    return null;
  } catch (error) {
    log?.("debug", "\u83B7\u53D6\u7FA4\u6210\u5458\u5217\u8868\u5931\u8D25", error);
    return null;
  }
}

// src/services/affinity/calculator.ts
function normalizeAction(action) {
  const text = typeof action === "string" ? action.toLowerCase() : "";
  if (text === "increase" || text === "decrease") return text;
  return "increase";
}
function resolveShortTermConfig(config) {
  const dynamics = config?.affinityDynamics || {};
  const cfg = dynamics.shortTerm || {};
  const defaults = AFFINITY_DYNAMICS_DEFAULTS.shortTerm;
  const promoteRaw = Number(cfg.promoteThreshold);
  const demoteRaw = Number(cfg.demoteThreshold);
  let promoteThreshold = Number.isFinite(promoteRaw) ? Math.round(promoteRaw) : defaults.promoteThreshold;
  let demoteThreshold = Number.isFinite(demoteRaw) ? Math.round(demoteRaw) : defaults.demoteThreshold;
  if (promoteThreshold <= demoteThreshold) {
    const midpoint = Math.round((promoteThreshold + demoteThreshold) / 2) || 0;
    promoteThreshold = midpoint + 15;
    demoteThreshold = midpoint - 15;
  }
  const promoteStepRaw = Number(cfg.longTermPromoteStep);
  const demoteStepRaw = Number(cfg.longTermDemoteStep);
  const longTermPromoteStep = Math.max(
    1,
    Math.round(
      Math.abs(
        Number.isFinite(promoteStepRaw) ? promoteStepRaw : Number.isFinite(cfg.longTermStep) ? cfg.longTermStep : defaults.longTermPromoteStep
      )
    )
  );
  const longTermDemoteStep = Math.max(
    1,
    Math.round(
      Math.abs(
        Number.isFinite(demoteStepRaw) ? demoteStepRaw : Number.isFinite(cfg.longTermStep) ? cfg.longTermStep : defaults.longTermDemoteStep
      )
    )
  );
  return {
    disableShortTermAffinity: dynamics.disableShortTermAffinity === true,
    promoteThreshold,
    demoteThreshold,
    longTermPromoteStep,
    longTermDemoteStep
  };
}
function resolveActionWindowConfig(config) {
  const cfg = config?.affinityDynamics?.actionWindow || {};
  const defaults = AFFINITY_DYNAMICS_DEFAULTS.actionWindow;
  const windowHoursRaw = Number(cfg.windowHours);
  const windowHours = Math.max(
    1,
    Number.isFinite(windowHoursRaw) ? windowHoursRaw : defaults.windowHours
  );
  const increaseBonus = Number.isFinite(cfg.increaseBonus) ? cfg.increaseBonus : defaults.increaseBonus;
  const decreaseBonus = Number.isFinite(cfg.decreaseBonus) ? cfg.decreaseBonus : defaults.decreaseBonus;
  const bonusChatThresholdRaw = Number(cfg.bonusChatThreshold);
  const bonusChatThreshold = Math.max(
    0,
    Number.isFinite(bonusChatThresholdRaw) ? Math.round(bonusChatThresholdRaw) : defaults.bonusChatThreshold
  );
  const maxEntriesRaw = Number(cfg.maxEntries);
  const maxEntries = Math.max(
    10,
    Number.isFinite(maxEntriesRaw) ? Math.round(maxEntriesRaw) : defaults.maxEntries
  );
  return {
    windowHours,
    windowMs: windowHours * 3600 * 1e3,
    increaseBonus,
    decreaseBonus,
    bonusChatThreshold,
    maxEntries
  };
}
function resolveCoefficientConfig(config) {
  const dynamics = config?.affinityDynamics || {};
  const cfg = dynamics.coefficient || {};
  const defaults = AFFINITY_DYNAMICS_DEFAULTS.coefficient;
  const base = Number.isFinite(cfg.base) ? cfg.base : defaults.base;
  const maxDrop = Math.max(
    0,
    Number.isFinite(cfg.maxDrop) ? cfg.maxDrop : defaults.maxDrop
  );
  const maxBoost = Math.max(
    0,
    Number.isFinite(cfg.maxBoost) ? cfg.maxBoost : defaults.maxBoost
  );
  const decayPerDay = Math.max(
    0,
    Number.isFinite(cfg.decayPerDay) ? cfg.decayPerDay : defaults.decayPerDay
  );
  const boostPerDay = Math.max(
    0,
    Number.isFinite(cfg.boostPerDay) ? cfg.boostPerDay : defaults.boostPerDay
  );
  const min = base - maxDrop;
  const max = base + maxBoost;
  return {
    disableAffinityCoefficient: dynamics.disableAffinityCoefficient === true,
    base,
    maxDrop,
    maxBoost,
    decayPerDay,
    boostPerDay,
    min,
    max
  };
}
function summarizeActionEntries(rawEntries, windowMs, nowMs) {
  const fallback = {
    entries: [],
    counts: { increase: 0, decrease: 0 },
    total: 0
  };
  if (!Array.isArray(rawEntries)) return fallback;
  const cutoff = nowMs - windowMs;
  const entries = [];
  const counts = { increase: 0, decrease: 0 };
  for (const entry of rawEntries) {
    if (!entry) continue;
    const ts = Number(entry.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const normalizedAction = normalizeAction(entry.action);
    entries.push({ action: normalizedAction, timestamp: ts });
    counts[normalizedAction] += 1;
  }
  return { entries, counts, total: counts.increase + counts.decrease };
}
function appendActionEntry(entries, action, nowMs, maxEntries) {
  const next = Array.isArray(entries) ? [...entries] : [];
  next.push({ action: normalizeAction(action), timestamp: nowMs });
  if (next.length > maxEntries) next.splice(0, next.length - maxEntries);
  return next;
}
function computeShortTermReset() {
  return 0;
}
function dayNumber2(date) {
  return Math.floor(date.getTime() / 864e5);
}
function computeDailyStreak(previousStreak, lastInteractionAt, now) {
  const last = lastInteractionAt instanceof Date ? lastInteractionAt : null;
  const currentDay = dayNumber2(now);
  const previousDay = last ? dayNumber2(last) : null;
  if (previousDay === null) return 1;
  if (previousDay === currentDay) return Math.max(1, previousStreak || 1);
  if (previousDay === currentDay - 1)
    return Math.max(1, (previousStreak || 0) + 1);
  return 1;
}
function computeCoefficientValue(coefConfig, streak, lastInteractionAt, now, todayIncreaseCount = 0, todayDecreaseCount = 0) {
  const lastMs = lastInteractionAt instanceof Date ? lastInteractionAt.getTime() : null;
  const nowMs = now.getTime();
  const inactivityDays = lastMs ? Math.max(0, Math.floor((nowMs - lastMs) / 864e5)) : 0;
  const hasInteractedToday = inactivityDays === 0;
  const isPositiveDay = todayIncreaseCount > todayDecreaseCount;
  const isNegativeDay = todayDecreaseCount > todayIncreaseCount;
  let decayPenalty = 0;
  let streakBoost = 0;
  if (!hasInteractedToday || isNegativeDay) {
    if (!hasInteractedToday) {
      decayPenalty = Math.min(
        coefConfig.maxDrop,
        inactivityDays * coefConfig.decayPerDay
      );
    } else if (isNegativeDay) {
      decayPenalty = Math.min(coefConfig.maxDrop, coefConfig.decayPerDay);
    }
  }
  if (hasInteractedToday && isPositiveDay && streak > 0) {
    streakBoost = Math.min(
      coefConfig.maxBoost,
      Math.max(0, (Math.max(1, streak) - 1) * coefConfig.boostPerDay)
    );
  }
  const coefficient = clampFloat(
    coefConfig.base - decayPenalty + streakBoost,
    coefConfig.min,
    coefConfig.max
  );
  return { coefficient, decayPenalty, streakBoost, inactivityDays };
}
function composeState(longTerm, shortTerm, clampFn) {
  return {
    affinity: clampFn(longTerm),
    longTermAffinity: clampFn(longTerm),
    shortTermAffinity: Math.round(shortTerm)
  };
}
function formatActionCounts(counts) {
  const safe = counts || {};
  const increase = Number(safe.increase) || 0;
  const decrease = Number(safe.decrease) || 0;
  return `\u63D0\u5347 ${increase} / \u964D\u4F4E ${decrease}`;
}

// src/services/affinity/store.ts
function createAffinityStore(options) {
  const { ctx, config } = options;
  const resolveInitialAffinity = () => Number.isFinite(config.initialAffinity) ? config.initialAffinity : BASE_AFFINITY_DEFAULTS.initialAffinity;
  const resolveMin = () => {
    const levels = config.relationshipAffinityLevels || [];
    if (levels.length === 0) return 0;
    return Math.min(...levels.map((l) => l.min));
  };
  const resolveMax = () => {
    const levels = config.relationshipAffinityLevels || [];
    if (levels.length === 0) return 100;
    return Math.max(...levels.map((l) => l.max));
  };
  const clampValue = (value) => clamp(Math.round(value), resolveMin(), resolveMax());
  const resolveRelationByAffinity = (affinity) => {
    const levels = config.relationshipAffinityLevels || [];
    for (const level of levels) {
      if (affinity >= level.min && affinity <= level.max) {
        return level.relation || null;
      }
    }
    return null;
  };
  const randomInitial = () => defaultInitial();
  const defaultInitial = () => clampValue(resolveInitialAffinity());
  const initialRange = () => ({
    low: defaultInitial(),
    high: defaultInitial(),
    min: resolveMin(),
    max: resolveMax()
  });
  const composeState2 = (longTerm, shortTerm) => ({
    affinity: clampValue(longTerm),
    longTermAffinity: clampValue(longTerm),
    shortTermAffinity: Math.round(shortTerm)
  });
  const createInitialState = (base) => composeState2(base, 0);
  const extractState = (record) => {
    if (!record) {
      const base = defaultInitial();
      return {
        affinity: base,
        longTermAffinity: base,
        shortTermAffinity: 0,
        chatCount: 0,
        actionStats: {
          entries: [],
          total: 0,
          counts: { increase: 0, decrease: 0 }
        },
        lastInteractionAt: null,
        coefficientState: {
          streak: 0,
          coefficient: 1,
          decayPenalty: 0,
          streakBoost: 0,
          inactivityDays: 0,
          lastInteractionAt: null
        },
        isNew: true
      };
    }
    let actionStats = {
      entries: [],
      total: 0,
      counts: { increase: 0, decrease: 0 }
    };
    if (record.actionStats) {
      try {
        const parsed = JSON.parse(record.actionStats);
        actionStats = {
          entries: parsed.entries || [],
          total: parsed.total || 0,
          counts: {
            increase: Number(parsed.counts?.increase) || 0,
            decrease: Number(parsed.counts?.decrease) || 0
          }
        };
      } catch {
      }
    }
    let coefficientState = {
      streak: 0,
      coefficient: 1,
      decayPenalty: 0,
      streakBoost: 0,
      inactivityDays: 0,
      lastInteractionAt: null
    };
    if (record.coefficientState) {
      try {
        const parsed = JSON.parse(record.coefficientState);
        coefficientState = {
          streak: parsed.streak || 0,
          coefficient: parsed.coefficient ?? 1,
          decayPenalty: parsed.decayPenalty || 0,
          streakBoost: parsed.streakBoost || 0,
          inactivityDays: parsed.inactivityDays || 0,
          lastInteractionAt: parsed.lastInteractionAt ? new Date(parsed.lastInteractionAt) : null
        };
      } catch {
      }
    }
    return {
      affinity: config.affinityDynamics?.disableAffinityCoefficient ? record.longTermAffinity ?? record.affinity : record.affinity,
      longTermAffinity: record.longTermAffinity ?? record.affinity,
      shortTermAffinity: config.affinityDynamics?.disableShortTermAffinity ? 0 : record.shortTermAffinity ?? 0,
      chatCount: record.chatCount || 0,
      actionStats,
      lastInteractionAt: record.lastInteractionAt || null,
      coefficientState
    };
  };
  const resolveScopeId = (scopeId) => String(scopeId || config.scopeId || "").trim();
  const load = async (scopeId, userId) => {
    const records = await ctx.database.get(MODEL_NAME_V2, { scopeId, userId });
    return records[0] || null;
  };
  const save = async (seed, value, specialRelation = "", extra) => {
    const scopeId = resolveScopeId(seed.scopeId);
    const userId = seed.userId || seed.session?.userId;
    if (!scopeId || !userId) return null;
    const existing = await load(scopeId, userId);
    const sessionUserId = seed.session?.userId;
    const isTargetingSelf = !sessionUserId || sessionUserId === userId;
    let nickname = seed.nickname || null;
    if (!nickname && isTargetingSelf) {
      const author = seed.session?.author;
      const user = seed.session?.user;
      nickname = seed.authorNickname || author?.nickname || author?.name || user?.nickname || user?.name || seed.session?.username || seed.session?.nickname || null;
    }
    if (!nickname) {
      nickname = existing?.nickname || null;
    }
    const hasStateOverride = extra && (extra.longTermAffinity !== void 0 || extra.shortTermAffinity !== void 0);
    const targetAffinity = Number.isFinite(value) ? clampValue(value) : existing?.affinity ?? defaultInitial();
    let longTerm;
    let shortTerm;
    if (hasStateOverride) {
      longTerm = extra.longTermAffinity !== void 0 ? clampValue(extra.longTermAffinity) : existing?.longTermAffinity ?? targetAffinity;
      shortTerm = extra.shortTermAffinity !== void 0 ? Math.round(extra.shortTermAffinity) : existing?.shortTermAffinity ?? 0;
    } else if (existing) {
      if (Number.isFinite(value)) {
        longTerm = targetAffinity;
        shortTerm = 0;
      } else {
        longTerm = existing.longTermAffinity ?? existing.affinity;
        shortTerm = existing.shortTermAffinity ?? 0;
      }
    } else {
      longTerm = targetAffinity;
      shortTerm = 0;
    }
    let coefficient = 1;
    if (extra?.coefficientState?.coefficient !== void 0) {
      coefficient = extra.coefficientState.coefficient;
    } else if (existing?.coefficientState) {
      try {
        const parsed = typeof existing.coefficientState === "string" ? JSON.parse(existing.coefficientState) : existing.coefficientState;
        if (typeof parsed?.coefficient === "number") {
          coefficient = parsed.coefficient;
        }
      } catch {
      }
    }
    const compositeAffinity = config.affinityDynamics?.disableAffinityCoefficient ? clampValue(longTerm) : clampValue(Math.round(longTerm * coefficient));
    const autoRelation = resolveRelationByAffinity(compositeAffinity) || null;
    const specialRelationText = specialRelation || existing?.specialRelation || null;
    const row = {
      scopeId,
      userId,
      nickname,
      affinity: compositeAffinity,
      longTermAffinity: clampValue(longTerm),
      shortTermAffinity: config.affinityDynamics?.disableShortTermAffinity ? 0 : Math.round(shortTerm),
      relation: autoRelation,
      specialRelation: specialRelationText
    };
    if (extra?.chatCount !== void 0) row.chatCount = extra.chatCount;
    if (extra?.actionStats) row.actionStats = JSON.stringify(extra.actionStats);
    if (extra?.coefficientState) {
      row.coefficientState = JSON.stringify(extra.coefficientState);
    }
    if (extra?.lastInteractionAt) {
      row.lastInteractionAt = extra.lastInteractionAt;
    }
    await ctx.database.upsert(MODEL_NAME_V2, [row]);
    return row;
  };
  const ensureForSeed = async (seed, userId, clampFn, fallbackInitial) => {
    const scopeId = resolveScopeId(seed.scopeId);
    if (!scopeId || !userId) return extractState(null);
    const existing = await load(scopeId, userId);
    if (existing) return extractState(existing);
    const initial = fallbackInitial !== void 0 ? clampFn(fallbackInitial, resolveMin(), resolveMax()) : defaultInitial();
    const initialState = createInitialState(initial);
    await save({ ...seed, scopeId, userId }, initialState.affinity, "", {
      longTermAffinity: initialState.longTermAffinity,
      shortTermAffinity: initialState.shortTermAffinity
    });
    return { ...extractState(null), ...initialState, isNew: true };
  };
  const ensureForUser = async (scopeId, session, userId, clampFn, fallbackInitial) => ensureForSeed(
    { scopeId, platform: session.platform, userId, session },
    userId,
    clampFn,
    fallbackInitial
  );
  const ensure = async (scopeId, session, clampFn, fallbackInitial) => ensureForUser(
    scopeId,
    session,
    session.userId || "",
    clampFn,
    fallbackInitial
  );
  const recordInteraction = async (seed, userId) => {
    const scopeId = resolveScopeId(seed.scopeId);
    const normalizedUserId = String(
      userId || seed.userId || seed.session?.userId || ""
    ).trim();
    if (!scopeId || !normalizedUserId) return null;
    await ensureForSeed(
      { ...seed, scopeId, userId: normalizedUserId },
      normalizedUserId,
      clamp
    );
    const existing = await load(scopeId, normalizedUserId);
    if (!existing) return null;
    const parsedCoefficientState = extractState(existing).coefficientState;
    const now = /* @__PURE__ */ new Date();
    const nextStreak = computeDailyStreak(
      parsedCoefficientState?.streak,
      parsedCoefficientState?.lastInteractionAt || existing.lastInteractionAt,
      now
    );
    const nextCoefficientState = {
      ...parsedCoefficientState,
      streak: nextStreak,
      lastInteractionAt: now
    };
    return save(
      { ...seed, scopeId, userId: normalizedUserId },
      Number.NaN,
      existing.specialRelation || "",
      {
        longTermAffinity: existing.longTermAffinity ?? existing.affinity,
        shortTermAffinity: existing.shortTermAffinity ?? 0,
        chatCount: Math.max(0, Number(existing.chatCount || 0)) + 1,
        coefficientState: nextCoefficientState,
        lastInteractionAt: now
      }
    );
  };
  const displayAffinity = (record) => config.affinityDynamics?.disableAffinityCoefficient ? clampValue(record.longTermAffinity ?? record.affinity) : clampValue(record.affinity);
  return {
    clamp: clampValue,
    save,
    load,
    ensure,
    ensureForSeed,
    ensureForUser,
    recordInteraction,
    defaultInitial,
    randomInitial,
    initialRange,
    composeState: composeState2,
    createInitialState,
    extractState,
    displayAffinity
  };
}

// src/services/affinity/cache.ts
function createAffinityCache() {
  let entry = null;
  const match = (scopeId, userId) => entry !== null && entry.scopeId === scopeId && entry.userId === userId;
  return {
    get(scopeId, userId) {
      return match(scopeId, userId) ? entry.value : null;
    },
    set(scopeId, userId, value) {
      entry = { scopeId, userId, value };
    },
    clear(scopeId, userId) {
      if (match(scopeId, userId)) entry = null;
    },
    clearAll() {
      entry = null;
    }
  };
}

// src/services/message/history.ts
function createMessageHistory(options) {
  const { ctx, config, log } = options;
  const cache = /* @__PURE__ */ new Map();
  const limit = FETCH_CONSTANTS.MIN_HISTORY_LIMIT;
  const formatTimestamp2 = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date?.getTime())) return "\u672A\u77E5\u65F6\u95F4";
    const pad2 = (num) => String(num).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hour = pad2(date.getHours());
    const minute = pad2(date.getMinutes());
    const second = pad2(date.getSeconds());
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  };
  const makeKey = (session) => {
    if (!session) return "unknown";
    if (session.guildId) {
      return `${session.platform || "unknown"}:${session.selfId || "self"}:${session.guildId}:${session.channelId || session.guildId}`;
    }
    return `${session.platform || "unknown"}:${session.selfId || "self"}:direct:${session.channelId || session.userId || "unknown"}`;
  };
  const normalizeEntriesList = (entries, size) => {
    if (!Array.isArray(entries) || !entries.length) return [];
    return entries.slice(-size).map((item) => ({
      userId: item.userId || "",
      username: item.username || item.user?.name || item.author?.name || item.sender?.name || item.userId || "\u672A\u77E5\u7528\u6237",
      content: typeof item.content === "string" && item.content.trim() ? item.content.trim() : "[\u65E0\u6587\u672C\u5185\u5BB9]",
      timestamp: new Date(item.timestamp ?? Date.now()).getTime()
    })).sort((a, b) => a.timestamp - b.timestamp);
  };
  const record = (session) => {
    if (!session?.platform) return;
    if (session.selfId && session.userId === session.selfId) return;
    if (!session.userId) return;
    const key = makeKey(session);
    const list = cache.get(key) || [];
    list.push({
      userId: session.userId,
      username: session.username || session.author?.name || session.event?.user?.name || session.user?.name || session.userId,
      content: session.content ?? "",
      timestamp: new Date(session.timestamp ?? Date.now()).getTime()
    });
    if (list.length > limit) list.splice(0, list.length - limit);
    cache.set(key, list);
  };
  const readEntries = async (session, count) => {
    const cached = cache.get(makeKey(session));
    if (cached?.length) return cached.slice(-count);
    const db = ctx.database;
    if (!db?.tables?.message || !db.get) return [];
    try {
      const rows = await db.get(
        "message",
        { platform: session.platform, channelId: session.channelId },
        { limit: count, sort: { time: "desc" } }
      );
      return normalizeEntriesList(rows, count);
    } catch (error) {
      log("warn", "\u83B7\u53D6\u5386\u53F2\u6D88\u606F\u5931\u8D25", error);
      return [];
    }
  };
  const fetch2 = async (_session) => {
    return [];
  };
  const fetchEntries = async (session, count) => {
    if (count <= 0) return [];
    const entries = await readEntries(session, count);
    return entries.map((item) => ({ ...item }));
  };
  const clear = (session) => {
    const key = makeKey(session);
    cache.delete(key);
  };
  ctx.on("message", record);
  return {
    record,
    fetch: fetch2,
    fetchEntries,
    clear
  };
}

// src/services/model-response/processor.ts
var import_shared_chatluna_xmltools = __toESM(require_lib());

// src/services/affinity/apply-delta.ts
async function applyAffinityDelta(params) {
  const {
    seed,
    userId,
    delta,
    action,
    store,
    maxActionEntries,
    shortTermConfig,
    coefficientConfig,
    log
  } = params;
  try {
    const platform = seed.platform || "onebot";
    const current = await store.ensureForSeed(
      { ...seed, platform, userId },
      userId,
      (value, low, high) => Math.min(Math.max(value, low), high)
    );
    const longTerm = current?.longTermAffinity ?? 0;
    const shortTerm = current?.shortTermAffinity ?? 0;
    let actualDelta = Math.abs(delta);
    if (action === "decrease") {
      actualDelta = -actualDelta;
    }
    const rawShortTerm = shortTerm + actualDelta;
    const crossedPromoteThreshold = rawShortTerm >= shortTermConfig.promoteThreshold;
    const crossedDemoteThreshold = rawShortTerm <= shortTermConfig.demoteThreshold;
    let newLongTerm = longTerm;
    let newShortTerm = rawShortTerm;
    if (shortTermConfig.disableShortTermAffinity) {
      newLongTerm = store.clamp(longTerm + actualDelta);
      newShortTerm = 0;
    } else if (crossedPromoteThreshold) {
      newLongTerm = store.clamp(longTerm + shortTermConfig.longTermPromoteStep);
      newShortTerm = 0;
    } else if (crossedDemoteThreshold) {
      newLongTerm = store.clamp(longTerm - shortTermConfig.longTermDemoteStep);
      newShortTerm = 0;
    }
    const newActionStats = {
      total: (current?.actionStats?.total || 0) + 1,
      counts: {
        increase: (current?.actionStats?.counts?.increase || 0) + (action === "increase" ? 1 : 0),
        decrease: (current?.actionStats?.counts?.decrease || 0) + (action === "decrease" ? 1 : 0)
      },
      entries: appendActionEntry(
        current?.actionStats?.entries,
        action,
        Date.now(),
        maxActionEntries
      )
    };
    const nextCoefficientState = {
      ...current?.coefficientState || {
        streak: 0,
        coefficient: 1,
        decayPenalty: 0,
        streakBoost: 0,
        inactivityDays: 0,
        lastInteractionAt: null
      }
    };
    if (coefficientConfig) {
      const now = /* @__PURE__ */ new Date();
      const nowDay = Math.floor(now.getTime() / 864e5);
      let todayIncreaseCount = 0;
      let todayDecreaseCount = 0;
      for (const entry of newActionStats.entries || []) {
        const ts = Number(entry?.timestamp);
        if (!Number.isFinite(ts)) continue;
        if (Math.floor(ts / 864e5) !== nowDay) continue;
        if (entry.action === "increase") {
          todayIncreaseCount += 1;
        } else if (entry.action === "decrease") {
          todayDecreaseCount += 1;
        }
      }
      const result = computeCoefficientValue(
        coefficientConfig,
        Math.max(1, Number(nextCoefficientState.streak || 0)),
        current?.lastInteractionAt || current?.coefficientState?.lastInteractionAt,
        now,
        todayIncreaseCount,
        todayDecreaseCount
      );
      nextCoefficientState.coefficient = result.coefficient;
      nextCoefficientState.decayPenalty = result.decayPenalty;
      nextCoefficientState.streakBoost = result.streakBoost;
      nextCoefficientState.inactivityDays = result.inactivityDays;
    }
    const effectiveCoefficient = coefficientConfig?.disableAffinityCoefficient ? 1 : nextCoefficientState.coefficient ?? current?.coefficientState?.coefficient ?? 1;
    nextCoefficientState.coefficient = effectiveCoefficient;
    const newCombined = store.clamp(Math.round(newLongTerm * effectiveCoefficient));
    await store.save({ ...seed, platform, userId }, newCombined, "", {
      shortTermAffinity: newShortTerm,
      longTermAffinity: newLongTerm,
      actionStats: newActionStats,
      coefficientState: nextCoefficientState
    });
    const message = `\u597D\u611F\u5EA6\u8C03\u6574: scopeId=${seed.scopeId || ""}, user=${userId}, action=${action}, delta=${Math.abs(actualDelta)}, shortTerm=${newShortTerm}, longTerm=${newLongTerm}, coefficient=${effectiveCoefficient}, combined=${newCombined}, stats=increase:${newActionStats.counts.increase}/decrease:${newActionStats.counts.decrease}`;
    log?.("info", message);
    return {
      success: true,
      message,
      shortTermAffinity: newShortTerm,
      longTermAffinity: newLongTerm,
      combinedAffinity: newCombined,
      coefficient: effectiveCoefficient,
      delta: actualDelta,
      actionStats: newActionStats
    };
  } catch (error) {
    const errorMessage = `applyAffinityDelta failed: ${error.message}`;
    params.log?.("warn", errorMessage, error);
    return { success: false, message: errorMessage };
  }
}

// src/services/model-response/processor.ts
function resolveXmlScopeId(attrs, config) {
  const rawScopeId = String(attrs.scopeId || "").trim();
  if (!rawScopeId) return null;
  if (rawScopeId !== config.scopeId) return null;
  return rawScopeId;
}
function resolveInitNicknameCandidates(session) {
  return session?.username ? [session.username] : [];
}
async function initializeAffinityOnFirstReply(context, params) {
  const session = context.session;
  if (!session?.userId || !session.selfId) return;
  const allowedSelfIds = Array.isArray(params.config.botSelfIds) ? params.config.botSelfIds.map((item) => String(item || "").trim()).filter(Boolean) : [];
  if (allowedSelfIds.length > 0 && !allowedSelfIds.includes(session.selfId)) {
    return;
  }
  const platform = String(session.platform || "onebot").trim() || "onebot";
  const userId = String(session.userId || "").trim();
  if (!userId || userId === String(session.selfId || "").trim()) return;
  const existing = await params.store.load(params.config.scopeId, userId);
  if (existing) return;
  const member = await fetchMember(session, userId);
  const nickname = collectNicknameCandidates(
    member,
    userId,
    resolveInitNicknameCandidates(session)
  )[0] || userId;
  await params.store.ensureForSeed(
    {
      scopeId: params.config.scopeId,
      platform,
      userId,
      session,
      nickname
    },
    userId,
    params.store.clamp
  );
}
async function recordInteractionFromReply(context, params) {
  const session = context.session;
  if (!session?.userId || !session.selfId) return;
  const platform = String(session.platform || "onebot").trim() || "onebot";
  const userId = String(session.userId || "").trim();
  const selfId = String(session.selfId || "").trim();
  if (!userId || !selfId || userId === selfId) return;
  await params.store.recordInteraction(
    {
      scopeId: params.config.scopeId,
      platform,
      userId,
      session
    },
    userId
  );
}
function createModelResponseProcessor(params) {
  const {
    config,
    cache,
    store,
    blacklist,
    unblockPermanent,
    userAlias,
    shortTermConfig,
    actionWindowConfig,
    coefficientConfig,
    shouldExecuteXmlActions,
    log
  } = params;
  return async (context) => {
    const response = String(context?.response || "").trim();
    if (!response) return;
    const affinityTags = (0, import_shared_chatluna_xmltools.parseSelfClosingXmlTags)(response, "affinity");
    const blacklistTags = (0, import_shared_chatluna_xmltools.parseSelfClosingXmlTags)(response, "blacklist");
    const userAliasTags = (0, import_shared_chatluna_xmltools.parseSelfClosingXmlTags)(response, "userAlias");
    const relationshipTags = (0, import_shared_chatluna_xmltools.parseSelfClosingXmlTags)(response, "relationship");
    if (config.debugLogging) {
      log("debug", "\u62E6\u622A\u5230\u6A21\u578B\u8F93\u51FA\u4E8B\u4EF6", {
        scopeId: config.scopeId,
        length: response.length,
        affinityTagCount: affinityTags.length,
        blacklistTagCount: blacklistTags.length,
        userAliasTagCount: userAliasTags.length,
        relationshipTagCount: relationshipTags.length
      });
    }
    try {
      await initializeAffinityOnFirstReply(context, {
        config,
        store,
        log
      });
      await recordInteractionFromReply(context, {
        config,
        store
      });
      const executeXmlActions = shouldExecuteXmlActions?.() ?? true;
      if (executeXmlActions && config.affinityEnabled && config.xmlToolSettings.enableAffinityXmlToolCall) {
        for (const attrs of affinityTags) {
          const scopeId = resolveXmlScopeId(attrs, config);
          const action = String(attrs.action || "").trim().toLowerCase();
          const userId = String(
            attrs.userId || attrs.id || attrs.targetUserId || ""
          ).trim();
          const platform = String(attrs.platform || "onebot").trim();
          const delta = Number(attrs.delta || "");
          if (config.debugLogging) {
            log("debug", "\u5F00\u59CB\u5904\u7406 affinity XML", {
              scopeId,
              inputScopeId: attrs.scopeId || "",
              action,
              userId
            });
          }
          if (!scopeId) {
            log("warn", "\u5FFD\u7565 affinity XML\uFF1AscopeId \u975E\u6CD5\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5B9E\u4F8B", {
              scopeId,
              inputScopeId: attrs.scopeId || "",
              action,
              userId
            });
            continue;
          }
          if (!userId || !action) {
            log("warn", "\u5FFD\u7565 affinity XML\uFF1A\u7F3A\u5C11\u5FC5\u8981\u5B57\u6BB5", {
              scopeId,
              action,
              userId
            });
            continue;
          }
          if (action !== "increase" && action !== "decrease") {
            log("warn", "\u5FFD\u7565 affinity XML\uFF1Aaction \u975E\u6CD5", {
              scopeId,
              action,
              userId
            });
            continue;
          }
          if (!Number.isFinite(delta) || delta <= 0) {
            log("warn", "\u5FFD\u7565 affinity XML\uFF1Adelta \u975E\u6CD5", {
              scopeId,
              action,
              userId,
              delta
            });
            continue;
          }
          await applyAffinityDelta({
            seed: {
              scopeId,
              platform,
              userId
            },
            userId,
            delta,
            action,
            store: {
              ensureForSeed: store.ensureForSeed,
              save: store.save,
              clamp: store.clamp
            },
            maxActionEntries: actionWindowConfig.maxEntries,
            shortTermConfig,
            coefficientConfig,
            log
          });
          cache.clear(scopeId, userId);
        }
      } else if (config.debugLogging && affinityTags.length > 0) {
        log("debug", "\u8DF3\u8FC7 affinity XML \u5904\u7406", {
          scopeId: config.scopeId,
          affinityEnabled: config.affinityEnabled,
          executeXmlActions,
          enableAffinityXmlToolCall: config.xmlToolSettings.enableAffinityXmlToolCall,
          affinityTagCount: affinityTags.length
        });
      }
      if (executeXmlActions && config.xmlToolSettings.enableBlacklistXmlToolCall) {
        for (const attrs of blacklistTags) {
          const scopeId = resolveXmlScopeId(attrs, config);
          const action = String(attrs.action || "").trim().toLowerCase();
          const mode = String(attrs.mode || "").trim().toLowerCase();
          const platform = String(attrs.platform || "onebot").trim();
          const userId = String(
            attrs.userId || attrs.id || attrs.targetUserId || ""
          ).trim();
          const note = String(attrs.note || "xml").trim();
          if (config.debugLogging) {
            log("debug", "\u5F00\u59CB\u5904\u7406 blacklist XML", {
              scopeId,
              inputScopeId: attrs.scopeId || "",
              action,
              mode,
              userId
            });
          }
          if (!scopeId) {
            log("warn", "\u5FFD\u7565 blacklist XML\uFF1AscopeId \u975E\u6CD5\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5B9E\u4F8B", {
              scopeId,
              inputScopeId: attrs.scopeId || "",
              action,
              mode,
              userId
            });
            continue;
          }
          if (!userId || action !== "add" && action !== "remove") {
            log("warn", "\u5FFD\u7565 blacklist XML\uFF1Aaction \u6216 userId \u975E\u6CD5", {
              scopeId,
              action,
              mode,
              userId
            });
            continue;
          }
          if (action === "remove") {
            if (mode === "temporary") {
              await blacklist.removeTemporary(platform, userId);
              cache.clear(scopeId, userId);
              continue;
            }
            if (mode === "permanent") {
              await unblockPermanent({
                source: "xml",
                platform,
                userId,
                seed: { scopeId, platform, userId }
              });
              continue;
            }
            log("warn", "\u5FFD\u7565 blacklist XML\uFF1Aremove \u7684 mode \u975E\u6CD5", {
              scopeId,
              action,
              mode,
              userId
            });
            continue;
          }
          if (mode === "permanent") {
            const existing = await store.load(scopeId, userId);
            await blacklist.recordPermanent(platform, userId, {
              note,
              nickname: existing?.nickname || userId
            });
            cache.clear(scopeId, userId);
            continue;
          }
          if (mode === "temporary") {
            const durationHours = Number(attrs.durationHours || "");
            if (!Number.isFinite(durationHours) || durationHours <= 0) {
              log(
                "warn",
                "\u5FFD\u7565 blacklist XML\uFF1Atemporary \u7F3A\u5C11\u5408\u6CD5 durationHours",
                {
                  scopeId,
                  action,
                  mode,
                  userId,
                  durationHours
                }
              );
              continue;
            }
            const penalty = Math.max(
              0,
              Number(config.shortTermBlacklistPenalty ?? 5)
            );
            const existing = await store.load(scopeId, userId);
            const entry = await blacklist.recordTemporary(
              platform,
              userId,
              durationHours,
              penalty,
              {
                note,
                nickname: existing?.nickname || userId
              }
            );
            if (!entry) continue;
            if (existing && penalty > 0) {
              const nextAffinity = store.clamp(
                (existing.longTermAffinity ?? existing.affinity ?? 0) - penalty
              );
              await store.save(
                {
                  scopeId,
                  platform,
                  userId
                },
                nextAffinity,
                existing.specialRelation || ""
              );
            }
            cache.clear(scopeId, userId);
            continue;
          }
          log("warn", "\u5FFD\u7565 blacklist XML\uFF1Aadd \u7684 mode \u975E\u6CD5", {
            scopeId,
            action,
            mode,
            userId
          });
        }
      } else if (config.debugLogging && blacklistTags.length > 0) {
        log("debug", "\u8DF3\u8FC7 blacklist XML \u5904\u7406", {
          scopeId: config.scopeId,
          executeXmlActions,
          enableBlacklistXmlToolCall: config.xmlToolSettings.enableBlacklistXmlToolCall,
          blacklistTagCount: blacklistTags.length
        });
      }
      if (executeXmlActions && config.xmlToolSettings.enableUserAliasXmlToolCall) {
        for (const attrs of userAliasTags) {
          const scopeId = resolveXmlScopeId(attrs, config);
          const platform = String(attrs.platform || "onebot").trim();
          const userId = String(
            attrs.userId || attrs.id || attrs.targetUserId || ""
          ).trim();
          const alias = String(attrs.name || attrs.alias || "").trim();
          if (config.debugLogging) {
            log("debug", "\u5F00\u59CB\u5904\u7406 userAlias XML", {
              scopeId,
              inputScopeId: attrs.scopeId || "",
              userId,
              alias
            });
          }
          if (!scopeId) {
            log("warn", "\u5FFD\u7565 userAlias XML\uFF1AscopeId \u975E\u6CD5\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5B9E\u4F8B", {
              scopeId,
              inputScopeId: attrs.scopeId || "",
              userId,
              alias
            });
            continue;
          }
          if (!userId || !alias) {
            log("warn", "\u5FFD\u7565 userAlias XML\uFF1A\u7F3A\u5C11\u5FC5\u8981\u5B57\u6BB5", {
              scopeId,
              userId,
              alias
            });
            continue;
          }
          await userAlias.setAlias(platform, userId, alias);
        }
      } else if (config.debugLogging && userAliasTags.length > 0) {
        log("debug", "\u8DF3\u8FC7 userAlias XML \u5904\u7406", {
          scopeId: config.scopeId,
          executeXmlActions,
          enableUserAliasXmlToolCall: config.xmlToolSettings.enableUserAliasXmlToolCall,
          userAliasTagCount: userAliasTags.length
        });
      }
      if (executeXmlActions && config.xmlToolSettings.enableRelationshipXmlToolCall) {
        for (const attrs of relationshipTags) {
          const scopeId = resolveXmlScopeId(attrs, config);
          const action = String(attrs.action || "set").trim().toLowerCase();
          const relation = String(attrs.relation || "").trim();
          const platform = String(attrs.platform || "onebot").trim();
          const userId = String(
            attrs.userId || attrs.id || attrs.targetUserId || ""
          ).trim();
          if (config.debugLogging) {
            log("debug", "\u5F00\u59CB\u5904\u7406 relationship XML", {
              scopeId,
              inputScopeId: attrs.scopeId || "",
              action,
              relation,
              userId
            });
          }
          if (!scopeId) {
            log("warn", "\u5FFD\u7565 relationship XML\uFF1AscopeId \u975E\u6CD5\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5B9E\u4F8B", {
              scopeId,
              inputScopeId: attrs.scopeId || "",
              action,
              relation,
              userId
            });
            continue;
          }
          if (!userId || action !== "set" && action !== "clear") {
            log("warn", "\u5FFD\u7565 relationship XML\uFF1Aaction \u6216 userId \u975E\u6CD5", {
              scopeId,
              action,
              relation,
              userId
            });
            continue;
          }
          if (action === "set" && !relation) {
            log("warn", "\u5FFD\u7565 relationship XML\uFF1Aset \u7F3A\u5C11 relation", {
              scopeId,
              action,
              userId
            });
            continue;
          }
          await store.save(
            {
              scopeId,
              platform,
              userId
            },
            Number.NaN,
            action === "clear" ? "" : relation
          );
          cache.clear(scopeId, userId);
        }
      } else if (config.debugLogging && relationshipTags.length > 0) {
        log("debug", "\u8DF3\u8FC7 relationship XML \u5904\u7406", {
          scopeId: config.scopeId,
          executeXmlActions,
          enableRelationshipXmlToolCall: config.xmlToolSettings.enableRelationshipXmlToolCall,
          relationshipTagCount: relationshipTags.length
        });
      }
    } catch (error) {
      log("warn", "\u5904\u7406\u6A21\u578B\u8F93\u51FA\u4E8B\u4EF6\u5931\u8D25", { scopeId: config.scopeId, error });
    }
  };
}

// src/services/model-response/temp-runtime.ts
var import_shared_chatluna_xmltools2 = __toESM(require_lib());
var objectIds = /* @__PURE__ */ new WeakMap();
var nextObjectId = 1;
function getObjectId(value) {
  const existing = objectIds.get(value);
  if (existing) return existing;
  const id = nextObjectId;
  nextObjectId += 1;
  objectIds.set(value, id);
  return id;
}
function logDiagnostic(enabled, log, message, detail) {
  if (!enabled) return;
  log?.("info", message, detail);
}
function getListenerSet(service) {
  const record = service;
  return record[/* @__PURE__ */ Symbol.for("chatlunaXmlToolsGetTempListeners:chatluna-affinity")] || /* @__PURE__ */ new Set();
}
function createCharacterTempModelResponseRuntime(params) {
  const {
    getCharacterService,
    processModelResponse,
    log,
    logActivation = false
  } = params;
  return (0, import_shared_chatluna_xmltools2.createCharacterTempRuntime)({
    getCharacterService,
    symbolNamespace: "chatluna-affinity",
    resolveSession: (args) => args[0] && typeof args[0] === "object" ? args[0] : null,
    onServiceMissing: () => {
      log?.("warn", "chatluna_character.getTemp \u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7 temp \u6A21\u578B\u54CD\u5E94\u9002\u914D");
    },
    onServiceChanged: ({ changed, previousService, nextService }) => {
      if (!changed) {
        logDiagnostic(
          logActivation,
          log,
          "\u6A21\u578B\u54CD\u5E94 runtime \u68C0\u6D4B\u5230\u5F53\u524D service \u672A\u53D8\u5316",
          {
            serviceId: getObjectId(nextService),
            changed: false
          }
        );
        return;
      }
      logDiagnostic(logActivation, log, "\u6A21\u578B\u54CD\u5E94 runtime \u68C0\u6D4B\u5230 service \u53D8\u5316", {
        previousServiceId: previousService ? getObjectId(previousService) : null,
        nextServiceId: getObjectId(nextService),
        changed: true
      });
      const listenerSetAfter = getListenerSet(nextService);
      logDiagnostic(logActivation, log, "\u6A21\u578B\u54CD\u5E94 runtime \u5DF2\u63A5\u7BA1 getTemp", {
        serviceId: getObjectId(nextService),
        listenerCount: listenerSetAfter.size,
        originalEqualsCurrentBeforePatch: false,
        originalEqualsPatchedAfterPatch: false,
        repeatedPatch: listenerSetAfter.size > 1
      });
      logDiagnostic(logActivation, log, "\u6A21\u578B\u54CD\u5E94 runtime \u5DF2\u6CE8\u518C getTemp \u76D1\u542C\u5668", {
        serviceId: getObjectId(nextService),
        listenerCount: listenerSetAfter.size,
        getTempPatched: true
      });
    },
    onStarted: ({ changed }) => {
      if (changed && logActivation) {
        log?.("info", "\u5DF2\u542F\u7528\u57FA\u4E8E getTemp \u7684\u6A21\u578B\u54CD\u5E94\u9002\u914D");
      }
    },
    onListenerError: (error) => {
      log?.("warn", "\u5904\u7406 completionMessages \u6D88\u606F\u76D1\u542C\u5668\u5931\u8D25", error);
    },
    onResponseError: (error) => {
      log?.("warn", "\u5904\u7406 completionMessages \u6A21\u578B\u54CD\u5E94\u5931\u8D25", error);
    },
    onResponse: async ({ response, session }) => {
      await processModelResponse({ response, session });
    }
  });
}

// src/services/model-response/reply-tools.ts
function escapeAttr(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function asArrayOfObjects(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}
function readString(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized) return normalized;
    }
  }
  return "";
}
function readOptionalString(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string") {
      return value.trim();
    }
  }
  return "";
}
function readNumber(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const normalized = value.trim();
      if (!normalized) continue;
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Number.NaN;
}
function resolvePlatform(item) {
  return readOptionalString(item, ["platform"]) || "onebot";
}
function normalizeAction2(value) {
  const action = String(value ?? "").trim().toLowerCase();
  if (action === "increase" || action === "decrease") return action;
  return "";
}
function normalizeBlacklistAction(value) {
  const action = String(value ?? "").trim().toLowerCase();
  if (action === "add" || action === "remove") return action;
  return "";
}
function normalizeBlacklistMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "permanent" || mode === "temporary") return mode;
  return "";
}
function normalizeRelationshipAction(value) {
  const action = String(value ?? "set").trim().toLowerCase();
  if (action === "set" || action === "clear") return action;
  return "";
}
function platformAttr(item) {
  const platform = readOptionalString(item, ["platform"]);
  if (!platform || platform === "onebot") return "";
  return ` platform="${escapeAttr(platform)}"`;
}
function hasAnyXmlToolEnabled(config) {
  return Boolean(
    config.xmlToolSettings.enableAffinityXmlToolCall || config.xmlToolSettings.enableBlacklistXmlToolCall || config.xmlToolSettings.enableRelationshipXmlToolCall || config.xmlToolSettings.enableUserAliasXmlToolCall
  );
}
function hasReplyToolsEnabled(config) {
  return Boolean(config.xmlToolSettings.injectXmlToolAsReplyTool && hasAnyXmlToolEnabled(config));
}
function registerCharacterReplyTools(deps) {
  const {
    ctx,
    config,
    cache,
    store,
    blacklist,
    unblockPermanent,
    userAlias,
    shortTermConfig,
    actionWindowConfig,
    coefficientConfig,
    log
  } = deps;
  const service = ctx.chatluna_character;
  if (!service?.registerReplyToolField) {
    return () => {
    };
  }
  const disposers = [];
  const scopeId = config.scopeId;
  if (config.xmlToolSettings.injectXmlToolAsReplyTool && config.xmlToolSettings.enableAffinityXmlToolCall) {
    disposers.push(
      service.registerReplyToolField({
        name: "affinity_affinity",
        schema: {
          type: "array",
          description: "\u66F4\u65B0\u4E00\u4E2A\u6216\u591A\u4E2A\u7528\u6237\u7684\u597D\u611F\u5EA6\u3002",
          items: {
            type: "object",
            properties: {
              user_id: {
                type: "string",
                description: "\u76EE\u6807\u7528\u6237 ID\u3002"
              },
              action: {
                type: "string",
                enum: ["increase", "decrease"],
                description: "increase \u6216 decrease\u3002"
              },
              delta: {
                type: "number",
                description: "\u53D8\u5316\u5E45\u5EA6\uFF0C\u5FC5\u987B\u662F\u6B63\u6570\u3002"
              },
              platform: {
                type: "string",
                description: "\u53EF\u9009\u5E73\u53F0\uFF0C\u9ED8\u8BA4 onebot\u3002"
              }
            },
            required: ["user_id", "action", "delta"]
          }
        },
        async invoke(_, session, value) {
          for (const item of asArrayOfObjects(value)) {
            const userId = readString(item, ["user_id", "userId", "id"]);
            const action = normalizeAction2(item.action);
            const delta = readNumber(item, ["delta"]);
            const platform = resolvePlatform(item);
            if (!userId || !action || !Number.isFinite(delta) || delta <= 0) {
              continue;
            }
            await applyAffinityDelta({
              seed: {
                scopeId,
                platform,
                userId,
                session
              },
              userId,
              delta,
              action,
              store: {
                ensureForSeed: store.ensureForSeed,
                save: store.save,
                clamp: store.clamp
              },
              maxActionEntries: actionWindowConfig.maxEntries,
              shortTermConfig,
              coefficientConfig,
              log
            });
            cache.clear(scopeId, userId);
          }
        },
        render(_, __, value) {
          return asArrayOfObjects(value).flatMap((item) => {
            const userId = readString(item, ["user_id", "userId", "id"]);
            const action = normalizeAction2(item.action);
            const delta = readNumber(item, ["delta"]);
            if (!userId || !action || !Number.isFinite(delta) || delta <= 0) {
              return [];
            }
            return [
              `<affinity scopeId="${escapeAttr(scopeId)}" userId="${escapeAttr(userId)}" action="${escapeAttr(action)}" delta="${escapeAttr(delta)}"${platformAttr(item)} />`
            ];
          });
        }
      })
    );
  }
  if (config.xmlToolSettings.injectXmlToolAsReplyTool && config.xmlToolSettings.enableBlacklistXmlToolCall) {
    disposers.push(
      service.registerReplyToolField({
        name: "affinity_blacklist",
        schema: {
          type: "array",
          description: "\u65B0\u589E\u6216\u79FB\u9664\u4E00\u4E2A\u6216\u591A\u4E2A\u9ED1\u540D\u5355\u3002",
          items: {
            type: "object",
            properties: {
              user_id: {
                type: "string",
                description: "\u76EE\u6807\u7528\u6237 ID\u3002"
              },
              action: {
                type: "string",
                enum: ["add", "remove"],
                description: "add \u6216 remove\u3002"
              },
              mode: {
                type: "string",
                enum: ["permanent", "temporary"],
                description: "permanent \u6216 temporary\u3002"
              },
              duration_hours: {
                type: "number",
                description: "\u4E34\u65F6\u9ED1\u540D\u5355\u65F6\u957F\uFF08\u5C0F\u65F6\uFF09\uFF0C\u4EC5 temporary \u4E14 add \u65F6\u6709\u6548\u3002"
              },
              note: {
                type: "string",
                description: "\u53EF\u9009\u5907\u6CE8\u3002"
              },
              platform: {
                type: "string",
                description: "\u53EF\u9009\u5E73\u53F0\uFF0C\u9ED8\u8BA4 onebot\u3002"
              }
            },
            required: ["user_id", "action", "mode"]
          }
        },
        async invoke(_, __, value) {
          for (const item of asArrayOfObjects(value)) {
            const userId = readString(item, ["user_id", "userId", "id"]);
            const action = normalizeBlacklistAction(item.action);
            const mode = normalizeBlacklistMode(item.mode);
            const platform = resolvePlatform(item);
            const note = readOptionalString(item, ["note"]) || "xml";
            if (!userId || !action || !mode) {
              continue;
            }
            if (action === "remove") {
              if (mode === "temporary") {
                await blacklist.removeTemporary(platform, userId);
                cache.clear(scopeId, userId);
                continue;
              }
              if (mode === "permanent") {
                await unblockPermanent({
                  source: "xml",
                  platform,
                  userId,
                  seed: { scopeId, platform, userId }
                });
              }
              continue;
            }
            if (mode === "permanent") {
              const existing2 = await store.load(scopeId, userId);
              await blacklist.recordPermanent(platform, userId, {
                note,
                nickname: existing2?.nickname || userId
              });
              cache.clear(scopeId, userId);
              continue;
            }
            const durationHours = readNumber(item, [
              "duration_hours",
              "durationHours"
            ]);
            if (!Number.isFinite(durationHours) || durationHours <= 0) {
              continue;
            }
            const penalty = Math.max(0, Number(config.shortTermBlacklistPenalty ?? 5));
            const existing = await store.load(scopeId, userId);
            const entry = await blacklist.recordTemporary(
              platform,
              userId,
              durationHours,
              penalty,
              {
                note,
                nickname: existing?.nickname || userId
              }
            );
            if (!entry) continue;
            if (existing && penalty > 0) {
              const nextAffinity = store.clamp(
                (existing.longTermAffinity ?? existing.affinity ?? 0) - penalty
              );
              await store.save(
                {
                  scopeId,
                  platform,
                  userId
                },
                nextAffinity,
                existing.specialRelation || ""
              );
            }
            cache.clear(scopeId, userId);
          }
        },
        render(_, __, value) {
          return asArrayOfObjects(value).flatMap((item) => {
            const userId = readString(item, ["user_id", "userId", "id"]);
            const action = normalizeBlacklistAction(item.action);
            const mode = normalizeBlacklistMode(item.mode);
            if (!userId || !action || !mode) {
              return [];
            }
            const note = readOptionalString(item, ["note"]);
            const noteAttr = note ? ` note="${escapeAttr(note)}"` : "";
            const durationHours = readNumber(item, [
              "duration_hours",
              "durationHours"
            ]);
            const durationAttr = action === "add" && mode === "temporary" && Number.isFinite(durationHours) && durationHours > 0 ? ` durationHours="${escapeAttr(durationHours)}"` : "";
            return [
              `<blacklist scopeId="${escapeAttr(scopeId)}" userId="${escapeAttr(userId)}" action="${escapeAttr(action)}" mode="${escapeAttr(mode)}"${durationAttr}${noteAttr}${platformAttr(item)} />`
            ];
          });
        }
      })
    );
  }
  if (config.xmlToolSettings.injectXmlToolAsReplyTool && config.xmlToolSettings.enableRelationshipXmlToolCall) {
    disposers.push(
      service.registerReplyToolField({
        name: "affinity_relationship",
        schema: {
          type: "array",
          description: "\u8BBE\u7F6E\u6216\u6E05\u7A7A\u4E00\u4E2A\u6216\u591A\u4E2A\u7528\u6237\u7684\u5173\u7CFB\u3002",
          items: {
            type: "object",
            properties: {
              user_id: {
                type: "string",
                description: "\u76EE\u6807\u7528\u6237 ID\u3002"
              },
              action: {
                type: "string",
                enum: ["set", "clear"],
                description: "set \u6216 clear\u3002"
              },
              relation: {
                type: "string",
                description: "\u5173\u7CFB\u540D\uFF0C\u4EC5 action=set \u65F6\u9700\u8981\u3002"
              },
              platform: {
                type: "string",
                description: "\u53EF\u9009\u5E73\u53F0\uFF0C\u9ED8\u8BA4 onebot\u3002"
              }
            },
            required: ["user_id"]
          }
        },
        async invoke(_, __, value) {
          for (const item of asArrayOfObjects(value)) {
            const userId = readString(item, ["user_id", "userId", "id"]);
            const action = normalizeRelationshipAction(item.action);
            const relation = readOptionalString(item, ["relation"]);
            const platform = resolvePlatform(item);
            if (!userId || !action) {
              continue;
            }
            if (action === "set" && !relation) {
              continue;
            }
            await store.save(
              {
                scopeId,
                platform,
                userId
              },
              Number.NaN,
              action === "clear" ? "" : relation
            );
            cache.clear(scopeId, userId);
          }
        },
        render(_, __, value) {
          return asArrayOfObjects(value).flatMap((item) => {
            const userId = readString(item, ["user_id", "userId", "id"]);
            const action = normalizeRelationshipAction(item.action);
            const relation = readOptionalString(item, ["relation"]);
            if (!userId || !action) {
              return [];
            }
            if (action === "set" && !relation) {
              return [];
            }
            const relationAttr = action === "set" ? ` relation="${escapeAttr(relation)}"` : "";
            return [
              `<relationship scopeId="${escapeAttr(scopeId)}" userId="${escapeAttr(userId)}" action="${escapeAttr(action)}"${relationAttr}${platformAttr(item)} />`
            ];
          });
        }
      })
    );
  }
  if (config.xmlToolSettings.injectXmlToolAsReplyTool && config.xmlToolSettings.enableUserAliasXmlToolCall) {
    disposers.push(
      service.registerReplyToolField({
        name: "affinity_user_alias",
        schema: {
          type: "array",
          description: "\u8BBE\u7F6E\u4E00\u4E2A\u6216\u591A\u4E2A\u7528\u6237\u7684\u81EA\u5B9A\u4E49\u6635\u79F0\u3002",
          items: {
            type: "object",
            properties: {
              user_id: {
                type: "string",
                description: "\u76EE\u6807\u7528\u6237 ID\u3002"
              },
              name: {
                type: "string",
                description: "\u8981\u8BBE\u7F6E\u7684\u6635\u79F0\u3002"
              },
              platform: {
                type: "string",
                description: "\u53EF\u9009\u5E73\u53F0\uFF0C\u9ED8\u8BA4 onebot\u3002"
              }
            },
            required: ["user_id", "name"]
          }
        },
        async invoke(_, __, value) {
          for (const item of asArrayOfObjects(value)) {
            const userId = readString(item, ["user_id", "userId", "id"]);
            const name2 = readString(item, ["name", "alias"]);
            const platform = resolvePlatform(item);
            if (!userId || !name2) {
              continue;
            }
            await userAlias.setAlias(platform, userId, name2);
          }
        },
        render(_, __, value) {
          return asArrayOfObjects(value).flatMap((item) => {
            const userId = readString(item, ["user_id", "userId", "id"]);
            const name2 = readString(item, ["name", "alias"]);
            if (!userId || !name2) {
              return [];
            }
            return [
              `<userAlias scopeId="${escapeAttr(scopeId)}" userId="${escapeAttr(userId)}" name="${escapeAttr(name2)}"${platformAttr(item)} />`
            ];
          });
        }
      })
    );
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      dispose();
    }
  };
}

// src/services/model-response/reference-prompt.ts
var import_messages = require("@langchain/core/messages");
function buildAffinityMechanismPrompt(config) {
  const dynamics = config.affinityDynamics || {};
  const shortTermDisabled = dynamics.disableShortTermAffinity === true;
  const coefficientDisabled = dynamics.disableAffinityCoefficient === true;
  const shortTerm = dynamics.shortTerm || {};
  const coefficient = dynamics.coefficient || {};
  const rules = shortTermDisabled ? [
    "Affinity changes are applied directly to long-term affinity; short-term affinity is not used."
  ] : [
    `Affinity changes first accumulate in short-term affinity. When it reaches the threshold (increase: ${shortTerm.promoteThreshold ?? 15}, decrease: ${Math.abs(shortTerm.demoteThreshold ?? -10)}), it is converted into long-term affinity by the configured step.`
  ];
  if (!coefficientDisabled) {
    rules.push(
      `Long-term affinity is multiplied by the current coefficient (base coefficient: ${coefficient.base ?? 1}) to produce the displayed affinity.`
    );
  }
  const content = shortTermDisabled && coefficientDisabled ? "Affinity changes are applied directly to long-term affinity, and the displayed affinity is the long-term affinity." : rules.join(" ");
  return `<available_affinity_mechanism>
${content}
</available_affinity_mechanism>`;
}
function registerSystemPrompt(deps, prompt, failureMessage, successMessage) {
  if (!prompt) return null;
  const chatlunaService = deps.ctx.chatluna;
  const contextManager = chatlunaService?.contextManager;
  if (!contextManager?.pipeline) {
    deps.log?.("warn", failureMessage);
    return null;
  }
  const dispose = contextManager.pipeline(
    "after_system_prompts",
    async (runtime, next) => {
      runtime.result.push(new import_messages.SystemMessage(prompt));
      runtime.usedTokens += await runtime.tokenCounter(prompt);
      await next();
    },
    0
  );
  deps.log?.("info", successMessage);
  return dispose;
}
function registerCharacterPromptInjection(deps) {
  const { config, replaceScopeId = false, log } = deps;
  const settings = config.xmlToolSettings;
  if (!settings.autoInjectReferencePrompt) return null;
  if (settings.injectXmlToolAsReplyTool) {
    log?.(
      "debug",
      "\u5DF2\u542F\u7528\u5B9E\u9A8C\u6027\u5DE5\u5177\u8C03\u7528\u56DE\u590D\uFF0C\u8DF3\u8FC7 Character XML \u53C2\u8003\u63D0\u793A\u8BCD\u81EA\u52A8\u6CE8\u5165"
    );
    return null;
  }
  const template = settings.characterPromptTemplate.trim();
  const prompt = replaceScopeId ? template.replaceAll("{scopeId}", config.scopeId) : template;
  return registerSystemPrompt(
    deps,
    prompt,
    "Character XML \u53C2\u8003\u63D0\u793A\u8BCD\u81EA\u52A8\u6CE8\u5165\u5931\u8D25\uFF1AChatLuna \u4E0A\u4E0B\u6587\u7BA1\u7406\u5668\u4E0D\u53EF\u7528",
    `Character XML \u53C2\u8003\u63D0\u793A\u8BCD\u81EA\u52A8\u6CE8\u5165\u5DF2\u542F\u7528: ${config.scopeId}`
  );
}
function registerAffinityMechanismPromptInjection(deps) {
  if (deps.config.autoInjectAffinityMechanismPrompt === false) return null;
  return registerSystemPrompt(
    deps,
    buildAffinityMechanismPrompt(deps.config),
    "\u597D\u611F\u5EA6\u673A\u5236\u63D0\u793A\u8BCD\u81EA\u52A8\u6CE8\u5165\u5931\u8D25\uFF1AChatLuna \u4E0A\u4E0B\u6587\u7BA1\u7406\u5668\u4E0D\u53EF\u7528",
    `\u597D\u611F\u5EA6\u673A\u5236\u63D0\u793A\u8BCD\u81EA\u52A8\u6CE8\u5165\u5DF2\u542F\u7528: ${deps.config.scopeId}`
  );
}

// src/services/native-tools/register.ts
var import_tools2 = require("@langchain/core/tools");
var import_zod = require("zod");
var NATIVE_TOOL_DEFAULT_AVAILABILITY = {
  enabled: true,
  main: true,
  chatluna: true,
  characterScope: "all"
};
function createNativeToolMeta(tags) {
  return {
    source: "extension",
    group: "affinity",
    tags,
    defaultAvailability: NATIVE_TOOL_DEFAULT_AVAILABILITY
  };
}
function getSession(runnable) {
  return runnable?.configurable?.session || null;
}
function resolvePlatform2(session) {
  return String(session?.platform || "onebot").trim() || "onebot";
}
function resolveToolName(value, fallback) {
  return value.trim() || fallback;
}
function resolveToolDescription(value, fallback) {
  return value.trim() || fallback;
}
function isNativeToolEnabled(config, toolKey) {
  return Boolean(
    config.nativeToolSettings.enabledNativeTools?.includes(toolKey)
  );
}
function registerNativeTools(deps) {
  const {
    config,
    cache,
    store,
    blacklist,
    unblockPermanent,
    userAlias,
    shortTermConfig,
    actionWindowConfig,
    coefficientConfig,
    plugin,
    log
  } = deps;
  const scopeId = config.scopeId;
  const disposers = [];
  const registerTool = (name2, tool) => {
    const dispose = plugin.registerTool(name2, tool);
    if (typeof dispose === "function") disposers.push(dispose);
  };
  if (isNativeToolEnabled(config, "affinity") && config.affinityEnabled) {
    const toolName = resolveToolName(
      config.nativeToolSettings.affinity.toolName,
      "affinity_affinity"
    );
    const description = resolveToolDescription(
      config.nativeToolSettings.affinity.description,
      DEFAULT_AFFINITY_NATIVE_TOOL_DESCRIPTION
    );
    registerTool(toolName, {
      selector: () => true,
      authorization: () => true,
      description,
      createTool: () => new class extends import_tools2.StructuredTool {
        name = toolName;
        description = description;
        schema = import_zod.z.object({
          userId: import_zod.z.string().min(1, "userId is required"),
          action: import_zod.z.enum(["increase", "decrease"]),
          delta: import_zod.z.number().positive("delta must be positive")
        });
        async _call(input, _manager, runnable) {
          const session = getSession(runnable);
          const platform = resolvePlatform2(session);
          await applyAffinityDelta({
            seed: {
              scopeId,
              platform,
              userId: input.userId,
              session: session || void 0
            },
            userId: input.userId,
            delta: input.delta,
            action: input.action,
            store: {
              ensureForSeed: store.ensureForSeed,
              save: store.save,
              clamp: store.clamp
            },
            maxActionEntries: actionWindowConfig.maxEntries,
            shortTermConfig,
            coefficientConfig,
            log
          });
          cache.clear(scopeId, input.userId);
          const sign = input.action === "increase" ? "+" : "-";
          return `\u5DF2\u8C03\u6574 ${input.userId} \u7684\u597D\u611F\u5EA6\uFF1A${sign}${input.delta}`;
        }
      }(),
      meta: createNativeToolMeta(["affinity"])
    });
    log?.("info", `\u597D\u611F\u5EA6\u539F\u751F\u5DE5\u5177\u5DF2\u6CE8\u518C: ${toolName}`);
  }
  if (isNativeToolEnabled(config, "blacklist")) {
    const toolName = resolveToolName(
      config.nativeToolSettings.blacklist.toolName,
      "affinity_blacklist"
    );
    const description = resolveToolDescription(
      config.nativeToolSettings.blacklist.description,
      DEFAULT_BLACKLIST_NATIVE_TOOL_DESCRIPTION
    );
    registerTool(toolName, {
      selector: () => true,
      authorization: () => true,
      description,
      createTool: () => new class extends import_tools2.StructuredTool {
        name = toolName;
        description = description;
        schema = import_zod.z.object({
          userId: import_zod.z.string().min(1, "userId is required"),
          action: import_zod.z.enum(["add", "remove"]),
          mode: import_zod.z.enum(["permanent", "temporary"]),
          durationHours: import_zod.z.number().positive().optional(),
          note: import_zod.z.string().optional()
        });
        async _call(input, _manager, runnable) {
          const session = getSession(runnable);
          const platform = resolvePlatform2(session);
          const note = input.note?.trim() || "native";
          if (input.action === "remove") {
            if (input.mode === "temporary") {
              await blacklist.removeTemporary(platform, input.userId);
              cache.clear(scopeId, input.userId);
              return `\u5DF2\u89E3\u9664 ${input.userId} \u7684\u4E34\u65F6\u9ED1\u540D\u5355`;
            }
            const result = await unblockPermanent({
              source: "native",
              platform,
              userId: input.userId,
              seed: { scopeId, platform, userId: input.userId, session: session || void 0 }
            });
            return result.removed ? `\u5DF2\u89E3\u9664 ${input.userId} \u7684\u6C38\u4E45\u9ED1\u540D\u5355` : `${input.userId} \u4E0D\u5728\u6C38\u4E45\u9ED1\u540D\u5355\u4E2D`;
          }
          if (input.mode === "permanent") {
            const existing2 = await store.load(scopeId, input.userId);
            await blacklist.recordPermanent(platform, input.userId, {
              note,
              nickname: existing2?.nickname || input.userId
            });
            cache.clear(scopeId, input.userId);
            return `\u5DF2\u5C06 ${input.userId} \u52A0\u5165\u6C38\u4E45\u9ED1\u540D\u5355`;
          }
          if (!input.durationHours) {
            return "\u6DFB\u52A0\u4E34\u65F6\u9ED1\u540D\u5355\u9700\u8981\u586B\u5199 durationHours";
          }
          const penalty = Math.max(
            0,
            Number(config.shortTermBlacklistPenalty ?? 5)
          );
          const existing = await store.load(scopeId, input.userId);
          const entry = await blacklist.recordTemporary(
            platform,
            input.userId,
            input.durationHours,
            penalty,
            {
              note,
              nickname: existing?.nickname || input.userId
            }
          );
          if (!entry) return `\u672A\u80FD\u5C06 ${input.userId} \u52A0\u5165\u4E34\u65F6\u9ED1\u540D\u5355`;
          if (existing && penalty > 0) {
            const nextAffinity = store.clamp(
              (existing.longTermAffinity ?? existing.affinity ?? 0) - penalty
            );
            await store.save(
              { scopeId, platform, userId: input.userId },
              nextAffinity,
              existing.specialRelation || ""
            );
          }
          cache.clear(scopeId, input.userId);
          return `\u5DF2\u5C06 ${input.userId} \u52A0\u5165\u4E34\u65F6\u9ED1\u540D\u5355 ${input.durationHours} \u5C0F\u65F6`;
        }
      }(),
      meta: createNativeToolMeta(["blacklist"])
    });
    log?.("info", `\u9ED1\u540D\u5355\u539F\u751F\u5DE5\u5177\u5DF2\u6CE8\u518C: ${toolName}`);
  }
  if (isNativeToolEnabled(config, "relationship")) {
    const toolName = resolveToolName(
      config.nativeToolSettings.relationship.toolName,
      "affinity_relationship"
    );
    const description = resolveToolDescription(
      config.nativeToolSettings.relationship.description,
      DEFAULT_RELATIONSHIP_NATIVE_TOOL_DESCRIPTION
    );
    registerTool(toolName, {
      selector: () => true,
      authorization: () => true,
      description,
      createTool: () => new class extends import_tools2.StructuredTool {
        name = toolName;
        description = description;
        schema = import_zod.z.object({
          userId: import_zod.z.string().min(1, "userId is required"),
          action: import_zod.z.enum(["set", "clear"]),
          relation: import_zod.z.string().optional()
        });
        async _call(input, _manager, runnable) {
          const relation = input.relation?.trim() || "";
          if (input.action === "set" && !relation) {
            return "\u8BBE\u7F6E\u5173\u7CFB\u9700\u8981\u586B\u5199 relation";
          }
          const platform = resolvePlatform2(getSession(runnable));
          await store.save(
            { scopeId, platform, userId: input.userId },
            Number.NaN,
            input.action === "clear" ? "" : relation
          );
          cache.clear(scopeId, input.userId);
          return input.action === "clear" ? `\u5DF2\u6E05\u7A7A ${input.userId} \u7684\u5173\u7CFB` : `\u5DF2\u5C06 ${input.userId} \u7684\u5173\u7CFB\u8BBE\u7F6E\u4E3A ${relation}`;
        }
      }(),
      meta: createNativeToolMeta(["relationship"])
    });
    log?.("info", `\u5173\u7CFB\u539F\u751F\u5DE5\u5177\u5DF2\u6CE8\u518C: ${toolName}`);
  }
  if (isNativeToolEnabled(config, "userAlias")) {
    const toolName = resolveToolName(
      config.nativeToolSettings.userAlias.toolName,
      "affinity_user_alias"
    );
    const description = resolveToolDescription(
      config.nativeToolSettings.userAlias.description,
      DEFAULT_USER_ALIAS_NATIVE_TOOL_DESCRIPTION
    );
    registerTool(toolName, {
      selector: () => true,
      authorization: () => true,
      description,
      createTool: () => new class extends import_tools2.StructuredTool {
        name = toolName;
        description = description;
        schema = import_zod.z.object({
          userId: import_zod.z.string().min(1, "userId is required"),
          name: import_zod.z.string().min(1, "name is required")
        });
        async _call(input, _manager, runnable) {
          const platform = resolvePlatform2(getSession(runnable));
          await userAlias.setAlias(platform, input.userId, input.name);
          return `\u5DF2\u5C06 ${input.userId} \u7684\u81EA\u5B9A\u4E49\u6635\u79F0\u8BBE\u7F6E\u4E3A ${input.name}`;
        }
      }(),
      meta: createNativeToolMeta(["alias"])
    });
    log?.("info", `\u81EA\u5B9A\u4E49\u6635\u79F0\u539F\u751F\u5DE5\u5177\u5DF2\u6CE8\u518C: ${toolName}`);
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

// src/services/blacklist/repository.ts
function createBlacklistService(options) {
  const { ctx, config, log } = options;
  const scopeId = String(config.scopeId || "").trim();
  const normalizeDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const toPermanentEntry = (record) => ({
    scopeId: record.scopeId,
    platform: record.platform,
    userId: record.userId,
    blockedAt: formatBeijingTimestamp(record.blockedAt),
    nickname: record.nickname || "",
    note: record.note || ""
  });
  const toTemporaryEntry = (record) => ({
    scopeId: record.scopeId,
    platform: record.platform,
    userId: record.userId,
    blockedAt: formatBeijingTimestamp(record.blockedAt),
    expiresAt: formatBeijingTimestamp(record.expiresAt || /* @__PURE__ */ new Date(0)),
    nickname: record.nickname || "",
    note: record.note || "",
    durationHours: record.durationHours ?? "",
    penalty: record.penalty ?? ""
  });
  const listByMode = async (mode, platform) => {
    const query = {
      scopeId,
      mode,
      ...platform ? { platform } : {}
    };
    const list = await ctx.database.get(BLACKLIST_MODEL_NAME_V2, query);
    return list;
  };
  const removeExpiredTemporary = async () => {
    const now = /* @__PURE__ */ new Date();
    const temporary = await listByMode("temporary");
    const expired = temporary.filter((item) => {
      const expiresAt = normalizeDate(item.expiresAt);
      return !expiresAt || expiresAt.getTime() <= now.getTime();
    });
    if (!expired.length) return;
    await Promise.all(
      expired.map(
        (item) => ctx.database.remove(BLACKLIST_MODEL_NAME_V2, {
          scopeId: item.scopeId,
          userId: item.userId,
          mode: "temporary"
        })
      )
    );
  };
  const isBlacklisted = async (platform, userId) => {
    const rows = await ctx.database.get(BLACKLIST_MODEL_NAME_V2, {
      scopeId,
      platform,
      userId,
      mode: "permanent"
    });
    return rows.length > 0;
  };
  const isTemporarilyBlacklisted = async (platform, userId) => {
    await removeExpiredTemporary();
    const rows = await ctx.database.get(BLACKLIST_MODEL_NAME_V2, {
      scopeId,
      platform,
      userId,
      mode: "temporary"
    });
    if (!rows.length) return null;
    const first = rows[0];
    const expiresAt = normalizeDate(first.expiresAt);
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      await ctx.database.remove(BLACKLIST_MODEL_NAME_V2, {
        scopeId,
        userId,
        mode: "temporary"
      });
      return null;
    }
    return toTemporaryEntry(first);
  };
  const listPermanent = async (platform) => {
    const records = await listByMode("permanent", platform);
    return records.map(toPermanentEntry);
  };
  const listTemporary = async (platform) => {
    await removeExpiredTemporary();
    const records = await listByMode("temporary", platform);
    return records.filter((record) => {
      const expiresAt = normalizeDate(record.expiresAt);
      return Boolean(expiresAt && expiresAt.getTime() > Date.now());
    }).map(toTemporaryEntry);
  };
  const recordPermanent = async (platform, userId, detail) => {
    const existing = await isBlacklisted(platform, userId);
    if (existing) return null;
    const row = {
      scopeId,
      platform,
      userId,
      mode: "permanent",
      blockedAt: /* @__PURE__ */ new Date(),
      expiresAt: null,
      nickname: detail?.nickname || null,
      note: detail?.note || "",
      durationHours: null,
      penalty: null
    };
    await ctx.database.upsert(BLACKLIST_MODEL_NAME_V2, [row]);
    log("info", "\u5DF2\u8BB0\u5F55\u6C38\u4E45\u62C9\u9ED1\u7528\u6237", { scopeId, platform, userId });
    return toPermanentEntry(row);
  };
  const removePermanent = async (platform, userId) => {
    const existing = await isBlacklisted(platform, userId);
    if (!existing) return false;
    await ctx.database.remove(BLACKLIST_MODEL_NAME_V2, {
      scopeId,
      userId,
      mode: "permanent"
    });
    return true;
  };
  const recordTemporary = async (platform, userId, durationHours, penalty, detail) => {
    const existing = await isTemporarilyBlacklisted(platform, userId);
    if (existing) return null;
    const now = /* @__PURE__ */ new Date();
    const expiresAt = new Date(now.getTime() + durationHours * 60 * 60 * 1e3);
    const row = {
      scopeId,
      platform,
      userId,
      mode: "temporary",
      blockedAt: now,
      expiresAt,
      nickname: detail?.nickname || null,
      note: detail?.note || "",
      durationHours,
      penalty
    };
    await ctx.database.upsert(BLACKLIST_MODEL_NAME_V2, [row]);
    log("info", "\u5DF2\u8BB0\u5F55\u4E34\u65F6\u62C9\u9ED1\u7528\u6237", {
      scopeId,
      platform,
      userId,
      durationHours,
      penalty
    });
    return toTemporaryEntry(row);
  };
  const removeTemporary = async (platform, userId) => {
    const existing = await isTemporarilyBlacklisted(platform, userId);
    if (!existing) return false;
    await ctx.database.remove(BLACKLIST_MODEL_NAME_V2, {
      scopeId,
      userId,
      mode: "temporary"
    });
    return true;
  };
  const shouldBlock = async (platform, userId) => {
    if (await isBlacklisted(platform, userId)) return true;
    const temporary = await isTemporarilyBlacklisted(platform, userId);
    return Boolean(temporary);
  };
  const clearAll = async () => {
    await ctx.database.remove(BLACKLIST_MODEL_NAME_V2, { scopeId });
  };
  return {
    shouldBlock,
    isBlacklisted,
    isTemporarilyBlacklisted,
    listPermanent,
    listTemporary,
    recordPermanent,
    removePermanent,
    recordTemporary,
    removeTemporary,
    clearAll
  };
}

// src/services/blacklist/guard.ts
function createBlacklistGuard(options) {
  const { config, blacklist, log } = options;
  const shouldBlock = async (session) => {
    const platform = session?.platform;
    const userId = session?.userId;
    if (!platform || !userId) return false;
    const blocked = await blacklist.shouldBlock(platform, userId);
    if (blocked && config.blacklistLogInterception) {
      log("info", "\u6D88\u606F\u88AB\u9ED1\u540D\u5355\u62E6\u622A", {
        scopeId: config.scopeId,
        platform,
        userId
      });
    }
    return blocked;
  };
  const middleware = async (session, next) => {
    if (await shouldBlock(session)) return;
    return next();
  };
  return {
    shouldBlock,
    middleware
  };
}

// src/services/blacklist/unblock-permanent.ts
function createPermanentUnblockHandler(deps) {
  const { config, log, store, cache, blacklist } = deps;
  return async (input) => {
    const { source, platform, userId, seed } = input;
    const exists = await blacklist.isBlacklisted(platform, userId);
    if (!exists) {
      log("info", "\u89E3\u9664\u6C38\u4E45\u9ED1\u540D\u5355\u672A\u547D\u4E2D\u76EE\u6807\u7528\u6237", {
        source,
        platform,
        userId
      });
      return {
        removed: false,
        affinityReset: false,
        affinity: null
      };
    }
    const nextAffinity = Number(config.unblockPermanentInitialAffinity ?? 0);
    const existing = await store.load(config.scopeId, userId);
    const removed = await blacklist.removePermanent(platform, userId);
    if (!removed) {
      log("warn", "\u89E3\u9664\u6C38\u4E45\u9ED1\u540D\u5355\u5931\u8D25\uFF0C\u5220\u9664\u9ED1\u540D\u5355\u8BB0\u5F55\u672A\u6210\u529F", {
        source,
        platform,
        userId
      });
      return {
        removed: false,
        affinityReset: false,
        affinity: null
      };
    }
    try {
      const saved = await store.save(
        {
          ...seed,
          platform,
          userId
        },
        nextAffinity,
        existing?.specialRelation || "",
        {
          longTermAffinity: nextAffinity,
          shortTermAffinity: 0,
          chatCount: 0,
          actionStats: {
            entries: [],
            total: 0,
            counts: { increase: 0, decrease: 0 }
          },
          coefficientState: {
            streak: 0,
            coefficient: 1,
            decayPenalty: 0,
            streakBoost: 0,
            inactivityDays: 0,
            lastInteractionAt: null
          },
          lastInteractionAt: /* @__PURE__ */ new Date(0)
        }
      );
      cache.clear(config.scopeId, userId);
      log("info", "\u89E3\u9664\u6C38\u4E45\u9ED1\u540D\u5355\u540E\u5DF2\u91CD\u7F6E\u597D\u611F\u5EA6", {
        scopeId: config.scopeId,
        source,
        platform,
        userId,
        affinity: saved?.affinity ?? nextAffinity
      });
      return {
        removed: true,
        affinityReset: true,
        affinity: saved?.affinity ?? nextAffinity
      };
    } catch (error) {
      await blacklist.recordPermanent(platform, userId, {
        note: `rollback:${source}`,
        nickname: existing?.nickname || userId
      });
      cache.clear(config.scopeId, userId);
      log("warn", "\u89E3\u9664\u6C38\u4E45\u9ED1\u540D\u5355\u540E\u91CD\u7F6E\u597D\u611F\u5EA6\u5931\u8D25\uFF0C\u5DF2\u56DE\u6EDA\u9ED1\u540D\u5355\u72B6\u6001", {
        scopeId: config.scopeId,
        source,
        platform,
        userId,
        error
      });
      return {
        removed: false,
        affinityReset: false,
        affinity: null
      };
    }
  };
}

// src/services/user-alias/repository.ts
function createUserAliasService(options) {
  const { ctx, scopeId, log } = options;
  const getAlias = async (_platform, userId) => {
    const rows = await ctx.database.get(USER_ALIAS_MODEL_NAME_V2, {
      scopeId,
      userId
    });
    return rows[0]?.alias || null;
  };
  const setAlias = async (platform, userId, alias) => {
    const row = {
      scopeId,
      platform,
      userId,
      alias,
      updatedAt: /* @__PURE__ */ new Date()
    };
    await ctx.database.upsert(USER_ALIAS_MODEL_NAME_V2, [row]);
    log("info", "\u5DF2\u8BBE\u7F6E\u7528\u6237\u81EA\u5B9A\u4E49\u6635\u79F0", { scopeId, platform, userId, alias });
    return row;
  };
  return {
    getAlias,
    setAlias
  };
}

// src/services/relationship/manual-config.ts
function createManualRelationshipManager(options) {
  const { ctx, config, log } = options;
  const find = (_platform, userId) => {
    const list = config.relationships || [];
    return list.find((r) => r.userId === userId) || null;
  };
  const update = (userId, relationName) => {
    const list = config.relationships || [];
    const existing = list.find((r) => r.userId === userId);
    if (existing) {
      config.relationships = list.map(
        (item) => item.userId === userId ? { ...item, relation: relationName } : item
      );
    } else {
      config.relationships = [...list, { userId, relation: relationName }];
    }
  };
  const remove = async (userId) => {
    if (!config.relationships) return false;
    const list = config.relationships || [];
    const exists = list.some((item) => item.userId === userId);
    if (!exists) return false;
    config.relationships = list.filter((item) => item.userId !== userId);
    try {
      const records = await ctx.database.get(MODEL_NAME_V2, {
        scopeId: config.scopeId,
        userId
      });
      const existing = records[0];
      if (existing) {
        await ctx.database.upsert(MODEL_NAME_V2, [
          { ...existing, specialRelation: null }
        ]);
      }
    } catch (error) {
      log("warn", "\u540C\u6B65\u5220\u9664\u5173\u7CFB\u5230\u6570\u636E\u5E93\u5931\u8D25", error);
    }
    return true;
  };
  const syncToDatabase = async () => {
    const relationships = config.relationships || [];
    if (relationships.length === 0) return;
    const relationshipMap = new Map(
      relationships.map((r) => [r.userId, r.relation])
    );
    const targetUserIds = relationships.map((r) => r.userId);
    if (targetUserIds.length === 0) return;
    const records = await ctx.database.get(MODEL_NAME_V2, {
      scopeId: config.scopeId,
      userId: { $in: targetUserIds }
    });
    const toUpdate = [];
    for (const record of records) {
      const configRelation = relationshipMap.get(record.userId);
      if (configRelation !== void 0 && record.specialRelation !== configRelation) {
        toUpdate.push({
          ...record,
          specialRelation: configRelation
        });
      }
    }
    if (toUpdate.length > 0) {
      await ctx.database.upsert(MODEL_NAME_V2, toUpdate);
      log("info", "\u5DF2\u540C\u6B65\u7279\u6B8A\u5173\u7CFB\u914D\u7F6E\u5230\u6570\u636E\u5E93", { count: toUpdate.length });
    }
  };
  return {
    find,
    update,
    remove,
    syncToDatabase
  };
}

// src/services/migration/index.ts
var MIGRATION_VERSION = "v2";
function createMigrationService(options) {
  const { ctx, scopeId, log } = options;
  const shouldMigrate = async () => {
    const records = await ctx.database.get(MIGRATION_MODEL_NAME, {
      scopeId,
      version: MIGRATION_VERSION
    });
    return records.length === 0 || records.some((item) => item.status === "failed");
  };
  const markMigration = async (status) => {
    await ctx.database.upsert(MIGRATION_MODEL_NAME, [
      {
        scopeId,
        version: MIGRATION_VERSION,
        migratedAt: /* @__PURE__ */ new Date(),
        status
      }
    ]);
  };
  const markSkipped = async () => {
    await markMigration("skipped");
  };
  const filterMissingRows = async (params) => {
    const legacyRows = await ctx.database.get(
      params.legacyModel,
      {}
    );
    if (legacyRows.length === 0) return [];
    const nextRows = legacyRows.map(params.toNextRow);
    const existingRows = await ctx.database.get(params.nextModel, {
      scopeId
    });
    const existingKeys = new Set(existingRows.map(params.getKey));
    return nextRows.filter((row) => !existingKeys.has(params.getKey(row)));
  };
  const migrateAffinity = async () => {
    const rows = await filterMissingRows({
      legacyModel: MODEL_NAME,
      nextModel: MODEL_NAME_V2,
      toNextRow: (row) => ({
        scopeId,
        ...row
      }),
      getKey: (row) => `${row.scopeId}:${row.userId}`
    });
    if (rows.length === 0) return 0;
    await ctx.database.upsert(MODEL_NAME_V2, rows);
    return rows.length;
  };
  const migrateBlacklist = async () => {
    const rows = await filterMissingRows({
      legacyModel: BLACKLIST_MODEL_NAME,
      nextModel: BLACKLIST_MODEL_NAME_V2,
      toNextRow: (row) => ({
        scopeId,
        ...row
      }),
      getKey: (row) => `${row.scopeId}:${row.userId}:${row.mode}`
    });
    if (rows.length === 0) return 0;
    await ctx.database.upsert(BLACKLIST_MODEL_NAME_V2, rows);
    return rows.length;
  };
  const migrateUserAlias = async () => {
    const rows = await filterMissingRows({
      legacyModel: USER_ALIAS_MODEL_NAME,
      nextModel: USER_ALIAS_MODEL_NAME_V2,
      toNextRow: (row) => ({
        scopeId,
        ...row
      }),
      getKey: (row) => `${row.scopeId}:${row.userId}`
    });
    if (rows.length === 0) return 0;
    await ctx.database.upsert(USER_ALIAS_MODEL_NAME_V2, rows);
    return rows.length;
  };
  const run = async () => {
    if (!scopeId) return;
    const needed = await shouldMigrate();
    if (!needed) return;
    try {
      const migrationOwners = await ctx.database.get(MIGRATION_MODEL_NAME, {
        scopeId,
        version: MIGRATION_VERSION
      });
      const hasSuccessOwner = migrationOwners.some(
        (item) => item.status === "success"
      );
      if (hasSuccessOwner) {
        await markSkipped();
        log("info", "\u8FC1\u79FB\u8DF3\u8FC7\uFF1A\u5DF2\u7531\u5176\u4ED6\u5B9E\u4F8B\u5B8C\u6210", { scopeId });
        return;
      }
      const legacyAffinityCount = (await ctx.database.get(MODEL_NAME, {})).length;
      const legacyBlacklistCount = (await ctx.database.get(BLACKLIST_MODEL_NAME, {})).length;
      const legacyAliasCount = (await ctx.database.get(USER_ALIAS_MODEL_NAME, {})).length;
      const legacyTotal = legacyAffinityCount + legacyBlacklistCount + legacyAliasCount;
      if (legacyTotal === 0) {
        await markSkipped();
        log("info", "\u8FC1\u79FB\u8DF3\u8FC7\uFF1A\u65E7\u8868\u65E0\u6570\u636E", { scopeId });
        return;
      }
      const affinityCount = await migrateAffinity();
      const blacklistCount = await migrateBlacklist();
      const aliasCount = await migrateUserAlias();
      await markMigration("success");
      log("info", "\u8FC1\u79FB\u5B8C\u6210", {
        scopeId,
        affinityCount,
        blacklistCount,
        aliasCount
      });
    } catch (error) {
      await markMigration("failed");
      log("warn", "\u8FC1\u79FB\u5931\u8D25", error);
    }
  };
  return { run };
}

// src/services/scope-registry.ts
var registries = /* @__PURE__ */ new WeakMap();
function getRegistry(root) {
  let registry = registries.get(root);
  if (!registry) {
    registry = { entries: [] };
    registries.set(root, registry);
  }
  return registry;
}
function notifyEntries(registry) {
  const scopeIds = new Set(registry.entries.map((entry) => entry.scopeId));
  const isOnlyScope = scopeIds.size === 1;
  const owner = isOnlyScope ? registry.entries[0] : void 0;
  for (const entry of registry.entries) {
    entry.notify({
      isOnlyScope,
      isOwner: entry === owner
    });
  }
}
function registerActiveScope(ctx, scopeId, notify) {
  const root = ctx.root;
  const registry = getRegistry(root);
  const entry = { scopeId, notify };
  registry.entries.push(entry);
  notifyEntries(registry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = registry.entries.indexOf(entry);
    if (index >= 0) registry.entries.splice(index, 1);
    if (registry.entries.length === 0) {
      registries.delete(root);
      return;
    }
    notifyEntries(registry);
  };
}

// src/services/dashboard/snapshot.ts
async function readRecordedDashboardSnapshots(ctx, scopeId) {
  const dashboardSnapshots = await ctx.database.get(
    DASHBOARD_SNAPSHOT_MODEL_NAME,
    { scopeId }
  );
  const userAffinitySnapshots = await ctx.database.get(
    USER_AFFINITY_SNAPSHOT_MODEL_NAME,
    { scopeId }
  );
  return { dashboardSnapshots, userAffinitySnapshots };
}
function formatSnapshotDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function parseSnapshotDate(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}
async function readDashboardSnapshotSource(ctx, scopeId) {
  const affinityRows = await ctx.database.get(MODEL_NAME_V2, { scopeId });
  const blacklistRows = await ctx.database.get(BLACKLIST_MODEL_NAME_V2, {
    scopeId
  });
  const aliasRows = await ctx.database.get(USER_ALIAS_MODEL_NAME_V2, {
    scopeId
  });
  return { affinityRows, blacklistRows, aliasRows };
}
function createDashboardSnapshot(scopeId, now, source, trigger = "backend") {
  const permanentBlacklisted = source.blacklistRows.filter(
    (row) => row.mode === "permanent"
  ).length;
  const temporaryBlacklisted = source.blacklistRows.filter(
    (row) => row.mode === "temporary"
  ).length;
  const latestInteractionAt = source.affinityRows.reduce(
    (latest, row) => {
      const value = row.lastInteractionAt;
      if (!value) return latest;
      if (!latest || value.getTime() > latest.getTime()) return value;
      return latest;
    },
    null
  );
  return {
    scopeId,
    date: formatSnapshotDate(now),
    recordedAt: now,
    generatedBy: trigger,
    users: source.affinityRows.length,
    affinityTotal: source.affinityRows.reduce(
      (total, row) => total + Number(row.affinity || 0),
      0
    ),
    longTermAffinityTotal: source.affinityRows.reduce(
      (total, row) => total + Number(row.longTermAffinity ?? row.affinity ?? 0),
      0
    ),
    shortTermAffinityTotal: source.affinityRows.reduce(
      (total, row) => total + Number(row.shortTermAffinity || 0),
      0
    ),
    chatCount: source.affinityRows.reduce(
      (total, row) => total + Number(row.chatCount || 0),
      0
    ),
    blacklisted: source.blacklistRows.length,
    permanentBlacklisted,
    temporaryBlacklisted,
    aliases: source.aliasRows.length,
    latestInteractionAt
  };
}
function createUserAffinitySnapshots(scopeId, now, source, existingSnapshots = []) {
  const date = formatSnapshotDate(now);
  const latestSnapshotsByUserId = /* @__PURE__ */ new Map();
  for (const snapshot of existingSnapshots) {
    if (snapshot.scopeId !== scopeId || !parseSnapshotDate(snapshot.date)) {
      continue;
    }
    const latest = latestSnapshotsByUserId.get(snapshot.userId);
    if (!latest || snapshot.date >= latest.date) {
      latestSnapshotsByUserId.set(snapshot.userId, snapshot);
    }
  }
  return source.affinityRows.filter((row) => {
    const latest = latestSnapshotsByUserId.get(row.userId);
    return !latest || Number(latest.affinity || 0) !== Number(row.affinity || 0) || Number(latest.longTermAffinity || 0) !== Number(row.longTermAffinity ?? row.affinity ?? 0) || Number(latest.chatCount || 0) !== Number(row.chatCount || 0);
  }).map((row) => ({
    scopeId,
    userId: row.userId,
    date,
    recordedAt: now,
    nickname: row.nickname || null,
    affinity: Number(row.affinity || 0),
    longTermAffinity: Number(row.longTermAffinity ?? row.affinity ?? 0),
    shortTermAffinity: Number(row.shortTermAffinity || 0),
    chatCount: Number(row.chatCount || 0),
    relation: row.relation || null,
    specialRelation: row.specialRelation || null,
    lastInteractionAt: row.lastInteractionAt || null
  }));
}
function hasSnapshotSourceData(source) {
  return source.affinityRows.length > 0 || source.blacklistRows.length > 0 || source.aliasRows.length > 0;
}
function mergeDashboardSnapshot(rows, snapshot) {
  return [
    ...rows.filter(
      (row) => row.scopeId !== snapshot.scopeId || row.date !== snapshot.date
    ),
    snapshot
  ];
}
function mergeUserAffinitySnapshots(rows, snapshots) {
  const snapshotKeys = new Set(
    snapshots.map(
      (snapshot) => `${snapshot.scopeId}:${snapshot.userId}:${snapshot.date}`
    )
  );
  return [
    ...rows.filter(
      (row) => !snapshotKeys.has(`${row.scopeId}:${row.userId}:${row.date}`)
    ),
    ...snapshots
  ];
}
async function recordDashboardSnapshot(ctx, options) {
  const scopeId = options.scopeId.trim();
  if (!scopeId) {
    return { dashboardSnapshots: [], userAffinitySnapshots: [] };
  }
  const now = options.now || /* @__PURE__ */ new Date();
  const source = options.source || await readDashboardSnapshotSource(ctx, scopeId);
  const existingSnapshots = options.existingSnapshots || await ctx.database.get(DASHBOARD_SNAPSHOT_MODEL_NAME, { scopeId });
  const existingUserAffinitySnapshots = options.existingUserAffinitySnapshots || await ctx.database.get(USER_AFFINITY_SNAPSHOT_MODEL_NAME, { scopeId });
  if (!hasSnapshotSourceData(source) && existingSnapshots.length === 0) {
    return {
      dashboardSnapshots: existingSnapshots,
      userAffinitySnapshots: existingUserAffinitySnapshots
    };
  }
  const snapshot = createDashboardSnapshot(
    scopeId,
    now,
    source,
    options.trigger
  );
  const userSnapshots = createUserAffinitySnapshots(
    scopeId,
    now,
    source,
    existingUserAffinitySnapshots
  );
  await ctx.database.upsert(DASHBOARD_SNAPSHOT_MODEL_NAME, [snapshot]);
  if (userSnapshots.length > 0) {
    await ctx.database.upsert(USER_AFFINITY_SNAPSHOT_MODEL_NAME, userSnapshots);
  }
  return {
    dashboardSnapshots: mergeDashboardSnapshot(existingSnapshots, snapshot),
    userAffinitySnapshots: mergeUserAffinitySnapshots(
      existingUserAffinitySnapshots,
      userSnapshots
    )
  };
}

// src/services/dashboard/backend.ts
var DEFAULT_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1e3;
function registerDashboardBackend(options) {
  const { config, ctx, log } = options;
  if (config.enableDashboard === false) return;
  const getNow = options.now || (() => /* @__PURE__ */ new Date());
  const intervalMs = options.sampleIntervalMs || DEFAULT_SNAPSHOT_INTERVAL_MS;
  const schedule = options.setInterval || setInterval;
  const clear = options.clearInterval || clearInterval;
  let timer = null;
  let running = false;
  const record = async () => {
    if (running) return;
    running = true;
    try {
      await recordDashboardSnapshot(ctx, {
        scopeId: config.scopeId,
        now: getNow()
      });
    } catch (error) {
      log("warn", "\u8BB0\u5F55\u4EEA\u8868\u76D8\u540E\u53F0\u5FEB\u7167\u5931\u8D25", error);
    } finally {
      running = false;
    }
  };
  ctx.on("ready", () => {
    if (timer !== null) return;
    void record();
    timer = schedule(() => {
      void record();
    }, intervalMs);
  });
  ctx.on("dispose", () => {
    if (timer === null) return;
    clear(timer);
    timer = null;
  });
}

// src/services/dashboard/index.ts
var DASHBOARD_EVENT = "chatluna-affinity/dashboard";
var DAY_MS = 24 * 60 * 60 * 1e3;
var WEEK_DAYS = 7;
var MONTH_DAYS = 30;
var HISTORY_POINT_LIMIT = 12;
function toIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
function toCount(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}
function roundAverage(total, count) {
  if (!count) return 0;
  return Math.round(total / count * 100) / 100;
}
function roundPercent(value) {
  return Math.round(value * 100) / 100;
}
function snapshotAffinityTotal(snapshot) {
  return toCount(snapshot.affinityTotal);
}
function snapshotUsers(snapshot) {
  return toCount(snapshot.users);
}
function snapshotChatCount(snapshot) {
  return toCount(snapshot.chatCount);
}
function snapshotBlacklisted(snapshot) {
  return toCount(snapshot.blacklisted);
}
function snapshotAliases(snapshot) {
  return toCount(snapshot.aliases);
}
function createMetricChange(current, previous) {
  return {
    current,
    previous,
    percent: previous === 0 ? current === 0 ? 0 : null : roundPercent((current - previous) / previous * 100)
  };
}
function getDisplayRelation(record) {
  return record.specialRelation || record.relation || "\u672A\u5206\u7EC4";
}
function getRelationKind(record) {
  return record.specialRelation ? "custom" : "preset";
}
function getRelationTone(record, levels) {
  if (record.specialRelation) return "custom";
  const relation = record.relation || "";
  const orderedLevels = [...levels || []].filter((level) => level.relation).sort((left, right) => left.min - right.min);
  const index = orderedLevels.findIndex((level) => level.relation === relation);
  if (index < 0) return "unknown";
  const ratio = orderedLevels.length > 1 ? index / (orderedLevels.length - 1) : 1;
  if (ratio <= 0.25) return "low";
  if (ratio < 0.75) return "medium";
  return "high";
}
function getDisplayName(record) {
  return record.nickname || record.userId;
}
function getOneBotAvatarUrl(userId) {
  const numericId = userId.match(/^\d+$/)?.[0];
  return numericId ? `https://q1.qlogo.cn/g?b=qq&nk=${numericId}&s=640` : null;
}
function getBlacklistDisplayName(record) {
  return record.nickname || record.userId;
}
function formatTrendLabel(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
function startOfLocalDay(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
function createEmptyTrendPoint(date) {
  return {
    label: formatTrendLabel(date),
    users: 0,
    averageAffinity: 0,
    chatCount: 0,
    blacklisted: 0
  };
}
function createSnapshotTrendPoint(snapshot) {
  const date = parseSnapshotDate(snapshot.date);
  if (!date) return null;
  return {
    label: formatTrendLabel(date),
    users: snapshotUsers(snapshot),
    averageAffinity: roundAverage(
      snapshotAffinityTotal(snapshot),
      snapshotUsers(snapshot)
    ),
    chatCount: snapshotChatCount(snapshot),
    blacklisted: snapshotBlacklisted(snapshot)
  };
}
function createDailyTrend(snapshots, anchor, days) {
  const snapshotsByDate = new Map(
    snapshots.map((snapshot) => [snapshot.date, snapshot])
  );
  const end = startOfLocalDay(anchor).getTime() + DAY_MS;
  const start = new Date(end - days * DAY_MS);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const snapshot = snapshotsByDate.get(formatSnapshotDate(date));
    const point = snapshot ? createSnapshotTrendPoint(snapshot) : null;
    return point || createEmptyTrendPoint(date);
  });
}
function createAllTrend(snapshots) {
  const latestByMonth = /* @__PURE__ */ new Map();
  for (const snapshot of snapshots) {
    const date = parseSnapshotDate(snapshot.date);
    if (!date) continue;
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    const current = latestByMonth.get(key);
    if (!current || snapshot.date > current.date) {
      latestByMonth.set(key, snapshot);
    }
  }
  return [...latestByMonth.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, snapshot]) => {
    const point = createSnapshotTrendPoint(snapshot);
    const date = parseSnapshotDate(snapshot.date);
    return {
      ...point || createEmptyTrendPoint(date || /* @__PURE__ */ new Date()),
      label: date ? `${date.getFullYear()}/${date.getMonth() + 1}` : snapshot.date
    };
  });
}
function getSnapshotTime(snapshot) {
  return parseSnapshotDate(snapshot.date)?.getTime() ?? null;
}
function getLatestSnapshotDate(snapshots) {
  const times = snapshots.map(getSnapshotTime).filter((value) => value !== null);
  if (!times.length) return null;
  return new Date(Math.max(...times));
}
function findLatestSnapshotInWindow(snapshots, start, end) {
  let latest = null;
  let latestTime = -Infinity;
  for (const snapshot of snapshots) {
    const time = getSnapshotTime(snapshot);
    if (time === null || time < start || time >= end || time < latestTime) {
      continue;
    }
    latest = snapshot;
    latestTime = time;
  }
  return latest;
}
function snapshotAverage(snapshot) {
  if (!snapshot) return 0;
  return roundAverage(snapshotAffinityTotal(snapshot), snapshotUsers(snapshot));
}
function createUserHistoryPoints(row, snapshots, trendAnchor) {
  const points = snapshots.map((snapshot) => {
    const date = parseSnapshotDate(snapshot.date);
    if (!date) return null;
    return {
      date,
      point: {
        label: formatTrendLabel(date),
        timestamp: toIsoString(snapshot.recordedAt) || toIsoString(date),
        affinity: toCount(snapshot.affinity),
        longTermAffinity: toCount(snapshot.longTermAffinity),
        chatCount: toCount(snapshot.chatCount)
      }
    };
  }).filter(
    (point) => point !== null
  ).sort((left, right) => left.date.getTime() - right.date.getTime());
  if (points.length) {
    const anchorDate = startOfLocalDay(trendAnchor);
    const latest = points.at(-1);
    if (latest && latest.date.getTime() < anchorDate.getTime()) {
      points.push({
        date: anchorDate,
        point: {
          label: formatTrendLabel(anchorDate),
          timestamp: toIsoString(anchorDate),
          affinity: latest.point.affinity,
          longTermAffinity: toCount(row.longTermAffinity ?? row.affinity),
          chatCount: toCount(row.chatCount)
        }
      });
    }
    return points.slice(-HISTORY_POINT_LIMIT).map(({ point }) => point);
  }
  return [
    {
      label: "\u5F53\u524D",
      timestamp: toIsoString(row.lastInteractionAt),
      affinity: toCount(row.affinity),
      longTermAffinity: toCount(row.longTermAffinity ?? row.affinity),
      chatCount: toCount(row.chatCount)
    }
  ];
}
function groupUserSnapshots(snapshots) {
  const grouped = /* @__PURE__ */ new Map();
  for (const snapshot of snapshots) {
    const rows = grouped.get(snapshot.userId) || [];
    rows.push(snapshot);
    grouped.set(snapshot.userId, rows);
  }
  return grouped;
}
async function getDashboardData(ctx, options) {
  const scopeId = options.scopeId;
  const now = options.now || /* @__PURE__ */ new Date();
  const relationshipAffinityLevels = options.relationshipAffinityLevels || [];
  const coefficientDisabled = options.affinityDynamics?.disableAffinityCoefficient === true;
  const affinityRows = await ctx.database.get(MODEL_NAME_V2, {
    scopeId
  });
  const blacklistRows = await ctx.database.get(BLACKLIST_MODEL_NAME_V2, {
    scopeId
  });
  const aliasRows = await ctx.database.get(USER_ALIAS_MODEL_NAME_V2, {
    scopeId
  });
  const recordedSnapshots = await readRecordedDashboardSnapshots(ctx, scopeId);
  const snapshotRows = recordedSnapshots.dashboardSnapshots;
  const userSnapshotRows = recordedSnapshots.userAffinitySnapshots;
  const trendAnchor = getLatestSnapshotDate(snapshotRows) || now;
  let chatCount = 0;
  let affinityTotal = 0;
  let longTermTotal = 0;
  let shortTermTotal = 0;
  let latestInteractionAt = null;
  const relationCounts = /* @__PURE__ */ new Map();
  const affinityByUserId = /* @__PURE__ */ new Map();
  const userSnapshotsByUserId = groupUserSnapshots(userSnapshotRows);
  for (const row of affinityRows) {
    chatCount += toCount(row.chatCount);
    const displayAffinity = coefficientDisabled ? toCount(row.longTermAffinity ?? row.affinity) : toCount(row.affinity);
    affinityTotal += displayAffinity;
    longTermTotal += toCount(row.longTermAffinity ?? row.affinity);
    shortTermTotal += options.affinityDynamics?.disableShortTermAffinity === true ? 0 : toCount(row.shortTermAffinity);
    const relation = getDisplayRelation(row);
    const kind = getRelationKind(row);
    const relationKey = `${kind}:${relation}`;
    const currentRelation = relationCounts.get(relationKey) || {
      relation,
      kind,
      count: 0
    };
    currentRelation.count += 1;
    relationCounts.set(relationKey, currentRelation);
    affinityByUserId.set(row.userId, displayAffinity);
    const currentInteractionAt = toIsoString(row.lastInteractionAt);
    if (currentInteractionAt && (!latestInteractionAt || currentInteractionAt > latestInteractionAt)) {
      latestInteractionAt = currentInteractionAt;
    }
  }
  const topUsers = [...affinityRows].sort(
    (left, right) => (coefficientDisabled ? toCount(right.longTermAffinity ?? right.affinity) : toCount(right.affinity)) - (coefficientDisabled ? toCount(left.longTermAffinity ?? left.affinity) : toCount(left.affinity))
  ).map((row) => ({
    userId: row.userId,
    name: getDisplayName(row),
    avatarUrl: getOneBotAvatarUrl(row.userId),
    affinity: coefficientDisabled ? toCount(row.longTermAffinity ?? row.affinity) : toCount(row.affinity),
    longTermAffinity: toCount(row.longTermAffinity ?? row.affinity),
    relation: getDisplayRelation(row),
    relationTone: getRelationTone(row, relationshipAffinityLevels),
    chatCount: toCount(row.chatCount),
    lastInteractionAt: toIsoString(row.lastInteractionAt),
    historyPoints: createUserHistoryPoints(
      row,
      userSnapshotsByUserId.get(row.userId) || [],
      trendAnchor
    )
  }));
  const relationStats = [...relationCounts.values()].sort((left, right) => right.count - left.count);
  const currentWeekEnd = startOfLocalDay(trendAnchor).getTime() + DAY_MS;
  const currentWeekStart = currentWeekEnd - WEEK_DAYS * DAY_MS;
  const previousWeekStart = currentWeekStart - WEEK_DAYS * DAY_MS;
  const currentWeekSnapshot = findLatestSnapshotInWindow(
    snapshotRows,
    currentWeekStart,
    currentWeekEnd
  );
  const previousWeekSnapshot = findLatestSnapshotInWindow(
    snapshotRows,
    previousWeekStart,
    currentWeekStart
  );
  const blacklistItems = [...blacklistRows].sort((left, right) => {
    const leftTime = toIsoString(left.blockedAt) || "";
    const rightTime = toIsoString(right.blockedAt) || "";
    return rightTime.localeCompare(leftTime);
  }).map((row) => ({
    platform: row.platform,
    userId: row.userId,
    name: getBlacklistDisplayName(row),
    avatarUrl: getOneBotAvatarUrl(row.userId),
    affinity: affinityByUserId.get(row.userId) ?? null,
    mode: row.mode,
    blockedAt: toIsoString(row.blockedAt),
    expiresAt: toIsoString(row.expiresAt),
    note: row.note || ""
  }));
  const permanentBlacklisted = blacklistRows.filter(
    (row) => row.mode === "permanent"
  ).length;
  const temporaryBlacklisted = blacklistRows.filter(
    (row) => row.mode === "temporary"
  ).length;
  return {
    scopeId,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    totals: {
      users: affinityRows.length,
      blacklisted: blacklistRows.length,
      permanentBlacklisted,
      temporaryBlacklisted,
      aliases: aliasRows.length,
      chatCount
    },
    averages: {
      affinity: roundAverage(affinityTotal, affinityRows.length),
      longTermAffinity: roundAverage(longTermTotal, affinityRows.length),
      shortTermAffinity: roundAverage(shortTermTotal, affinityRows.length)
    },
    latestInteractionAt,
    weeklyChanges: {
      users: createMetricChange(
        currentWeekSnapshot ? snapshotUsers(currentWeekSnapshot) : 0,
        previousWeekSnapshot ? snapshotUsers(previousWeekSnapshot) : 0
      ),
      averageAffinity: createMetricChange(
        snapshotAverage(currentWeekSnapshot),
        snapshotAverage(previousWeekSnapshot)
      ),
      chatCount: createMetricChange(
        currentWeekSnapshot ? snapshotChatCount(currentWeekSnapshot) : 0,
        previousWeekSnapshot ? snapshotChatCount(previousWeekSnapshot) : 0
      ),
      aliases: createMetricChange(
        currentWeekSnapshot ? snapshotAliases(currentWeekSnapshot) : 0,
        previousWeekSnapshot ? snapshotAliases(previousWeekSnapshot) : 0
      )
    },
    trends: {
      week: createDailyTrend(snapshotRows, trendAnchor, WEEK_DAYS),
      month: createDailyTrend(snapshotRows, trendAnchor, MONTH_DAYS),
      all: createAllTrend(snapshotRows)
    },
    relationStats,
    blacklistItems,
    topUsers
  };
}
function registerDashboardWebui(options) {
  const { config, ctx, entry, log } = options;
  if (config.enableDashboard === false) return;
  ctx.inject(["console"], (innerCtx) => {
    const consoleService = innerCtx.console;
    consoleService.addEntry(entry);
    consoleService.addListener(
      DASHBOARD_EVENT,
      async () => getDashboardData(ctx, {
        scopeId: config.scopeId,
        affinityDynamics: config.affinityDynamics,
        relationshipAffinityLevels: config.relationshipAffinityLevels
      }),
      { authority: 1 }
    );
    if (config.debugLogging) {
      log("debug", "\u5DF2\u6CE8\u518C\u63A7\u5236\u53F0\u4EEA\u8868\u76D8\u9875\u9762\u4E0E\u6570\u636E\u63A5\u53E3", {
        event: DASHBOARD_EVENT,
        scopeId: config.scopeId
      });
    }
  });
}

// src/renders/base.ts
var import_node_fs = require("fs");
var import_node_path = require("path");
var import_core = require("@takumi-rs/core");
var import_emoji = require("@takumi-rs/helpers/emoji");
var import_html = require("@takumi-rs/helpers/html");
var fonts = [
  "@fontsource-variable/noto-sans-sc",
  "@fontsource-variable/noto-sans-kr",
  "@fontsource-variable/noto-sans-jp"
].flatMap((fontPackage, packageIndex) => {
  const fontDirectory = (0, import_node_path.resolve)(
    (0, import_node_path.dirname)(require.resolve(`${fontPackage}/package.json`)),
    "files"
  );
  return (0, import_node_fs.readdirSync)(fontDirectory).filter((name2) => name2.endsWith(".woff2")).sort().map((name2, fontIndex) => ({
    name: `NotoSans${packageIndex}_${fontIndex}`,
    data: (0, import_node_fs.readFileSync)((0, import_node_path.resolve)(fontDirectory, name2))
  }));
});
var fontFamily = fonts.map((font) => `'${font.name}'`).join(",");
var renderer = new import_core.Renderer({ fonts, loadDefaultFonts: true });
function parseHtml(html) {
  const stylesheets = [];
  const content = html.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    (_, stylesheet) => {
      stylesheets.push(stylesheet);
      return "";
    }
  );
  const parsed = (0, import_html.fromHtml)(content);
  return {
    node: parsed.node,
    stylesheets: [...parsed.stylesheets, ...stylesheets].map(
      (stylesheet) => stylesheet.replaceAll('"Noto Sans SC"', fontFamily)
    )
  };
}
async function fetchRemoteImages(node) {
  const urls = /* @__PURE__ */ new Set();
  function collect(current) {
    if (current.type === "image" && typeof current.src === "string") {
      try {
        const url = new URL(current.src);
        if (url.protocol === "http:" || url.protocol === "https:") {
          urls.add(current.src);
        }
      } catch {
      }
    }
    if (current.type === "container") {
      current.children?.forEach(collect);
    }
  }
  collect(node);
  const images = await Promise.all(
    [...urls].map(async (src) => {
      try {
        const response = await fetch(src);
        if (!response.ok) return null;
        return { src, data: await response.arrayBuffer() };
      } catch {
        return null;
      }
    })
  );
  return images.filter((image) => image !== null);
}
async function renderHtml(html, options, log) {
  const {
    width = 600,
    height,
    deviceScaleFactor = 2
  } = options;
  try {
    const parsed = parseHtml(html);
    const node = (0, import_emoji.extractEmojis)(parsed.node, "twemoji");
    const images = await fetchRemoteImages(node);
    return await renderer.render(node, {
      width: width * deviceScaleFactor,
      height: height ? height * deviceScaleFactor : void 0,
      devicePixelRatio: deviceScaleFactor,
      format: "png",
      stylesheets: parsed.stylesheets,
      fetchedResources: images
    });
  } catch (error) {
    log?.("warn", "\u56FE\u7247\u6E32\u67D3\u5931\u8D25", error);
    return null;
  }
}

// src/renders/styles/common.ts
var COMMON_STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: "Noto Sans SC", sans-serif;
    background: #f0f2f5;
    color: #1f2937;
  }

  .container {
    padding: 32px;
    width: 600px;
    background: #f0f2f5;
    display: flex;
    flex-direction: column;
    gap: 16px;
    font-feature-settings: "palt";
  }

  .header {
    margin-bottom: 8px;
    padding: 0 8px;
  }

  h1 {
    font-size: 24px;
    margin: 0;
    font-weight: 700;
    color: #111827;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  
  h2 {
    font-size: 16px;
    font-weight: 500;
    color: #6b7280;
    margin-top: 4px;
  }

  .card {
    background: #ffffff;
    border-radius: 12px;
    padding: 16px;
    display: flex;
    align-items: center;
    gap: 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid #e5e7eb;
    flex-shrink: 0;
  }
  
  .avatar-placeholder {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #f3f4f6;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #9ca3af;
    font-weight: 600;
    font-size: 20px;
    border: 2px solid #e5e7eb;
  }

  .info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .name {
    font-size: 16px;
    font-weight: 600;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .sub-text {
    font-size: 12px;
    color: #6b7280;
  }

  .badge {
    font-size: 12px;
    padding: 2px 8px;
    background: #e0e7ff;
    color: #4f46e5;
    border-radius: 999px;
    font-weight: 500;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  
  .badge-red {
    background: #fee2e2;
    color: #ef4444;
  }

  .badge-orange {
    background: #ffedd5;
    color: #f97316;
  }
  
  .badge-gray {
    background: #f3f4f6;
    color: #6b7280;
  }

  .value-container {
    text-align: right;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    flex-shrink: 0;
  }

  .value-primary {
    font-size: 18px;
    font-weight: 700;
    color: #ec4899;
    font-feature-settings: "tnum";
  }
  
  .value-secondary {
    font-size: 14px;
    font-weight: 600;
    color: #4b5563;
  }

  .label-small {
    font-size: 12px;
    color: #6b7280;
  }

  .stat-label {
    font-size: 12px;
    color: #6b7280;
    margin-top: 4px;
  }
`;

// src/renders/rank-list.ts
var RANK_LIST_STYLE = `
    ${COMMON_STYLE}

    .rank-num {
      font-size: 20px;
      font-weight: 700;
      color: #9ca3af;
      width: 32px;
      text-align: center;
      font-feature-settings: "tnum";
    }

    .rank-top-1 { color: #fbbf24; font-size: 24px; }
    .rank-top-2 { color: #9ca3af; font-size: 22px; }
    .rank-top-3 { color: #b45309; font-size: 22px; }

    .affinity-container {
      text-align: right;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      justify-content: center;
    }

    .affinity-value {
      font-size: 18px;
      font-weight: 700;
      color: #ec4899;
      font-feature-settings: "tnum";
    }

    .affinity-label {
      font-size: 12px;
      color: #6b7280;
    }

    .relation-badge {
      font-size: 12px;
      padding: 2px 8px;
      background: #e0e7ff;
      color: #4f46e5;
      border-radius: 999px;
      font-weight: 500;
    }
`;
function truncateName(name2) {
  const characters = Array.from(name2);
  return characters.length > 16 ? `${characters.slice(0, 15).join("")}\u2026` : name2;
}
function buildRankListHtml(title, items) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>${RANK_LIST_STYLE}</style>
</head>
<body>
  <div class="container" id="list-root">
    <div class="header">
      <h1>${title}</h1>
    </div>
    ${items.map(
    (item) => `
    <div class="card">
      <div class="rank-num rank-top-${item.rank}">${item.rank}</div>
      ${item.avatarUrl ? `<img class="avatar" src="${item.avatarUrl}" onerror="this.style.display='none'" />` : '<div class="avatar" style="background: #e5e7eb"></div>'}
      <div class="info">
        <div class="name-row">
          <span class="name">${truncateName(item.name)}</span>
          ${item.relation && item.relation !== "\u2014\u2014" ? `<span class="relation-badge">${item.relation}</span>` : ""}
        </div>
      </div>
      <div class="affinity-container">
        <div class="affinity-value">${item.affinity}</div>
        <div class="affinity-label">\u597D\u611F\u5EA6</div>
      </div>
    </div>
    `
  ).join("")}
  </div>
</body>
</html>`;
}
function createRankListRenderer(log) {
  return async function renderRankList(title, items) {
    const html = buildRankListHtml(title, items);
    return renderHtml(
      html,
      {
        width: 600
        // 固定高度会在列表内容下方留下未被根节点背景覆盖的透明画布，
        // 发送后透明区域会显示为黑块。省略高度让 Takumi 按实际布局收缩。
      },
      log
    );
  };
}

// src/renders/inspect.ts
var INSPECT_STYLE = `
    ${COMMON_STYLE}
    .card-inspect {
      background: #ffffff;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
    }
    .header-inspect {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid #f3f4f6;
    }
    .avatar-lg {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      object-fit: cover;
      border: 4px solid #e5e7eb;
    }
    .avatar-placeholder-lg {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: #e5e7eb;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #9ca3af;
      font-weight: 600;
      font-size: 32px;
    }
    .nickname-lg {
      font-size: 24px;
      font-weight: 700;
      color: #111827;
      margin-bottom: 4px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-item {
      background: #f9fafb;
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      transition: all 0.2s;
    }
    .stat-value-lg {
      font-size: 28px;
      font-weight: 700;
      color: #111827;
      font-feature-settings: "tnum";
      line-height: 1.2;
    }
    .stat-value-lg.primary {
      color: #ec4899;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-top: 1px solid #f3f4f6;
      font-size: 14px;
    }
    .detail-label {
      color: #6b7280;
    }
    .detail-val {
      font-weight: 600;
      color: #374151;
    }
    .impression-section {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid #f3f4f6;
    }
    .impression-title {
      font-size: 14px;
      font-weight: 600;
      color: #6b7280;
      margin-bottom: 10px;
    }
    .impression-content {
      font-size: 14px;
      color: #374151;
      line-height: 1.6;
      background: #f9fafb;
      border-radius: 8px;
      padding: 12px;
    }
`;
function buildInspectHtml(data) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>${INSPECT_STYLE}</style>
</head>
<body>
  <div class="container" style="width: 480px; padding: 40px;" id="inspect-root">
    <div class="card-inspect">
      <div class="header-inspect">
        ${data.avatarUrl ? `<img class="avatar-lg" src="${data.avatarUrl}" onerror="this.style.display='none'" />` : `<div class="avatar-placeholder-lg">${data.nickname.charAt(0)}</div>`}
        <div class="user-info">
          <div class="nickname-lg">${data.nickname}</div>
          <div class="sub-text" style="font-size: 14px;">${data.platform ? `${data.platform}/` : ""}${data.userId}</div>
          ${data.relation && data.relation !== "\u2014\u2014" ? `<span class="badge" style="margin-top: 8px; display: inline-block;">${data.relation}</span>` : ""}
        </div>
      </div>
      
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-value-lg primary">${data.compositeAffinity}</div>
          <div class="stat-label">\u597D\u611F\u5EA6</div>
        </div>
        <div class="stat-item">
          <div class="stat-value-lg">${data.chatCount}</div>
          <div class="stat-label">\u4E92\u52A8\u6B21\u6570</div>
        </div>
        <div class="stat-item">
          <div class="stat-value-lg" style="font-size: 20px; color: #4b5563;">${data.longTermAffinity}</div>
          <div class="stat-label">\u957F\u671F\u597D\u611F\u5EA6</div>
        </div>
        <div class="stat-item">
          <div class="stat-value-lg" style="font-size: 20px; color: #4b5563;">${data.shortTermAffinity}</div>
          <div class="stat-label">\u77ED\u671F\u597D\u611F\u5EA6</div>
        </div>
      </div>

      <div class="detail-list">
        <div class="detail-row">
          <span class="detail-label">\u597D\u611F\u5EA6\u7CFB\u6570</span>
          <span class="detail-val">${data.coefficient.toFixed(2)}\uFF08\u8FDE\u7EED ${data.streak} \u5929\uFF09</span>
        </div>
        <div class="detail-row" style="border-bottom: 1px solid #f3f4f6;">
          <span class="detail-label">\u6700\u540E\u4E92\u52A8</span>
          <span class="detail-val">${data.lastInteraction || "\u2014\u2014"}</span>
        </div>
      </div>
      ${data.impression ? `
      <div class="impression-section">
        <div class="impression-title">\u5370\u8C61</div>
        <div class="impression-content">${data.impression}</div>
      </div>` : ""}
    </div>
  </div>
</body>
</html>`;
}
function createInspectRenderer(log) {
  return async function renderInspect(data) {
    const html = buildInspectHtml(data);
    return renderHtml(
      html,
      {
        width: 480
        // 印象长度不可控，固定画布会把超出 600px 的详情直接裁掉。
        // 省略高度让 Takumi 按根节点实际布局扩展完整图片。
      },
      log
    );
  };
}

// src/renders/blacklist.ts
var BLACKLIST_STYLE = `
    ${COMMON_STYLE}
    .note {
      font-size: 13px;
      color: #6b7280;
      margin-top: 4px;
    }
`;
function buildBlacklistHtml(title, items) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>${BLACKLIST_STYLE}</style>
</head>
<body>
  <div class="container" id="list-root">
    <div class="header">
      <h1>${title}</h1>
    </div>
    ${items.map(
    (item) => `
    <div class="card">
      <div class="rank-num" style="font-size: 16px; color: #9ca3af; width: 24px;">${item.index}</div>
      ${item.avatarUrl ? `<img class="avatar" src="${item.avatarUrl}" onerror="this.style.display='none'" />` : `<div class="avatar-placeholder">${item.nickname.charAt(0)}</div>`}
      <div class="info">
        <div class="name-row">
          <span class="name">${item.nickname}</span>
          ${item.tag ? `<span class="badge ${item.isTemp ? "badge-orange" : "badge-red"}" style="margin-left: 4px;">${item.tag}</span>` : ""}
        </div>
        <div class="sub-text">${item.userId}</div>
        ${item.note && item.note !== "\u2014\u2014" ? `<div class="note">\u5907\u6CE8: ${item.note}</div>` : ""}
      </div>
      <div class="value-container">
        <div class="value-secondary">${item.timeInfo}</div>
        ${item.isTemp && item.penalty ? `<div class="badge badge-red" style="margin-top: 4px;">\u6263\u9664 ${item.penalty} \u597D\u611F</div>` : ""}
      </div>
    </div>
    `
  ).join("")}
  </div>
</body>
</html>`;
}
function createBlacklistRenderer(log) {
  return async function renderBlacklist(title, items) {
    const html = buildBlacklistHtml(title, items);
    return renderHtml(
      html,
      {
        width: 600,
        height: 100 + items.length * 120
      },
      log
    );
  };
}

// src/renders/table.ts
var TABLE_STYLE = `
    body {
      margin: 0;
      font-family: "Noto Sans SC", sans-serif;
      background: #ffffff;
      color: #111111;
    }
    .container {
      padding: 20px 24px;
      max-width: 760px;
    }
    h1 {
      font-size: 18px;
      margin: 0 0 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sub-heading {
      margin: -8px 0 16px;
      color: #555555;
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      min-width: 360px;
      font-size: 14px;
      table-layout: fixed;
    }
    th, td {
      padding: 10px 14px;
      border-bottom: 1px solid #e5e5e5;
      text-align: left;
      vertical-align: top;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
    }
    .time-col {
      width: 150px;
      white-space: nowrap;
      padding-right: 18px;
      text-align: left;
      font-weight: 600;
    }
    td.time-col {
      font-weight: 500;
    }
    .content-col {
      width: calc(100% - 150px);
    }
    th {
      background: #f5f7fa;
      font-weight: 600;
      white-space: nowrap;
    }
    tr:nth-child(odd) td {
      background: #fbfcfe;
    }
`;
function buildTableHtml(title, headers, rows, options) {
  const heading = options.heading ?? title;
  const subHeading = options.subHeading ?? "";
  const normalizedRows = Array.isArray(rows) ? rows : [];
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>${TABLE_STYLE}</style>
</head>
<body>
  <div class="container" id="table-root">
    <h1>${heading}</h1>
    ${subHeading ? `<p class="sub-heading">${subHeading}</p>` : ""}
    <table>
      <thead>
        <tr>${headers.map((header, index) => `<th class="${index === 0 ? "time-col" : "content-col"}">${header}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${normalizedRows.map(
    (line) => `<tr>${line.map((cell, index) => `<td class="${index === 0 ? "time-col" : "content-col"}">${cell}</td>`).join("")}</tr>`
  ).join("")}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}
function createTableRenderer(log) {
  return async function renderTable(title, headers, rows, options = {}) {
    const normalizedRows = Array.isArray(rows) ? rows : [];
    const html = buildTableHtml(title, headers, normalizedRows, options);
    return renderHtml(
      html,
      {
        width: 800,
        height: 220 + normalizedRows.length * 48,
        deviceScaleFactor: 1
      },
      log
    );
  };
}

// src/renders/index.ts
function createRenderService(options) {
  const { log } = options;
  return {
    rankList: createRankListRenderer(log),
    inspect: createInspectRenderer(log),
    blacklist: createBlacklistRenderer(log),
    table: createTableRenderer(log)
  };
}

// src/integrations/chatluna/variables/affinity.ts
function createAffinityProvider(deps) {
  const { config, cache, store, fetchEntries, getUserAlias } = deps;
  const resolveRelationByAffinity = (affinity) => {
    const level = (config.relationshipAffinityLevels || []).find(
      (item) => affinity >= item.min && affinity <= item.max
    );
    return level?.relation || "\u672A\u77E5";
  };
  const resolveNickname = async (scopeId, platform, userId) => {
    const nickname = await getUserAlias?.(scopeId, platform, userId);
    return String(nickname || "").trim();
  };
  const formatRow = (row) => {
    const parts = [
      `id:${row.userId}`,
      `name:${row.name}`,
      row.nickname ? `nickname:${row.nickname}` : "",
      `affinity:${row.affinity}`,
      `relationship:${row.relationship}`,
      config.variableSettings.showChatCountInAffinityVariable ? `chatcount:${row.chatCount}` : ""
    ].filter(Boolean);
    return parts.join(" ");
  };
  return async (args, _variables, configurable) => {
    const session = configurable?.session;
    if (!session?.platform || !session?.userId) {
      return "";
    }
    const resolved = resolveScopedVariableArgs(args);
    const scopeId = resolved?.scopeId;
    if (!scopeId || !isValidScopeId(scopeId)) return "";
    const platform = session.platform;
    const targetUserId = resolved?.targetUserId || session.userId;
    const cached = cache.get(scopeId, targetUserId);
    if (cached !== null && (config.affinityDisplayRange ?? 1) <= 1 && !config.variableSettings.showChatCountInAffinityVariable && config.affinityDynamics?.disableAffinityCoefficient !== true) {
      const cachedNickname = await resolveNickname(
        scopeId,
        platform,
        targetUserId
      );
      return formatRow({
        userId: targetUserId,
        name: targetUserId,
        nickname: cachedNickname,
        affinity: cached,
        relationship: resolveRelationByAffinity(cached),
        chatCount: 0
      });
    }
    const currentRecord = await store.load(scopeId, targetUserId);
    const currentAffinity = config.affinityDynamics?.disableAffinityCoefficient ? currentRecord?.longTermAffinity ?? currentRecord?.affinity ?? store.defaultInitial() : currentRecord?.affinity ?? store.defaultInitial();
    const currentRelation = currentRecord?.specialRelation || currentRecord?.relation || resolveRelationByAffinity(currentAffinity);
    const currentName = currentRecord?.nickname || targetUserId;
    const currentNickname = await resolveNickname(
      scopeId,
      platform,
      targetUserId
    );
    cache.set(scopeId, targetUserId, currentAffinity);
    const displayRange = Math.max(
      1,
      Math.floor(config.affinityDisplayRange ?? 1)
    );
    if (displayRange <= 1) {
      return formatRow({
        userId: targetUserId,
        name: currentName,
        nickname: currentNickname,
        affinity: currentAffinity,
        relationship: currentRelation,
        chatCount: currentRecord?.chatCount || 0
      });
    }
    if (typeof fetchEntries !== "function") {
      return formatRow({
        userId: targetUserId,
        name: currentName,
        nickname: currentNickname,
        affinity: currentAffinity,
        relationship: currentRelation,
        chatCount: currentRecord?.chatCount || 0
      });
    }
    const entries = await fetchEntries(session, Math.max(1, displayRange * 10));
    const orderedUsers = [];
    const seen = /* @__PURE__ */ new Set([targetUserId]);
    for (const entry of entries) {
      const userId = entry.userId;
      if (!userId || userId === session.selfId) continue;
      if (seen.has(userId)) continue;
      seen.add(userId);
      orderedUsers.push({
        userId,
        username: entry.username || userId
      });
      if (orderedUsers.length >= displayRange - 1) break;
    }
    const rows = [];
    rows.push(
      formatRow({
        userId: targetUserId,
        name: currentName,
        nickname: currentNickname,
        affinity: currentAffinity,
        relationship: currentRelation,
        chatCount: currentRecord?.chatCount || 0
      })
    );
    if (!orderedUsers.length) return rows.join("\n");
    const others = await Promise.all(
      orderedUsers.map(async ({ userId, username }) => {
        const record = await store.load(scopeId, userId);
        const affinity = config.affinityDynamics?.disableAffinityCoefficient ? record?.longTermAffinity ?? record?.affinity ?? store.defaultInitial() : record?.affinity ?? store.defaultInitial();
        const relation = record?.specialRelation || record?.relation || resolveRelationByAffinity(affinity);
        const name2 = username || record?.nickname || userId;
        const nickname = await resolveNickname(scopeId, platform, userId);
        return formatRow({
          userId,
          name: name2,
          nickname,
          affinity,
          relationship: relation,
          chatCount: record?.chatCount || 0
        });
      })
    );
    rows.push(...others.filter(Boolean));
    return rows.join("\n");
  };
}

// src/integrations/chatluna/variables/relationship-level.ts
function createRelationshipLevelProvider(deps) {
  const { store, config } = deps;
  return async (args, _variables, configurable) => {
    const session = configurable?.session;
    const resolved = resolveScopedVariableArgs(args);
    const scopeId = resolved?.scopeId;
    if (!scopeId || scopeId !== config.scopeId) return "";
    const userId = String(
      resolved?.targetUserId || session?.userId || ""
    ).trim();
    if (!userId) return "";
    const levels = config.relationshipAffinityLevels || [];
    if (!levels.length) return "";
    await store.load(scopeId, userId);
    const lines = levels.map((level) => {
      const range = `${level.min}-${level.max}`;
      const note = level.note?.trim();
      const detail = note ? `${level.relation}\uFF08${note}\uFF09` : level.relation;
      return `${range}\uFF1A${detail}`;
    });
    return lines.join("\n");
  };
}

// src/integrations/chatluna/variables/blacklist-list.ts
function createBlacklistListProvider(deps) {
  const { scopeId, config, store, blacklist } = deps;
  return async (args, _variables, configurable) => {
    const session = configurable?.session;
    const platform = session?.platform;
    if (!session || !platform) return "";
    const resolved = resolveScopedVariableArgs(args);
    const resolvedScopeId = resolved?.scopeId;
    if (!resolvedScopeId || resolvedScopeId !== scopeId) return "";
    const groupId = resolveGroupId(session);
    if (!groupId) return "";
    const memberIds = await fetchGroupMemberIds(session);
    const members = memberIds || /* @__PURE__ */ new Set();
    const permanentRecords = await blacklist.listPermanent(platform);
    const temporaryRecords = await blacklist.listTemporary(platform);
    const records = [
      ...permanentRecords.map((entry) => ({
        userId: entry.userId,
        nickname: entry.nickname,
        blockedAt: entry.blockedAt,
        mode: "permanent"
      })),
      ...temporaryRecords.map((entry) => ({
        userId: entry.userId,
        nickname: entry.nickname,
        blockedAt: entry.blockedAt,
        expiresAt: entry.expiresAt,
        mode: "temporary"
      }))
    ];
    if (!records.length) return "";
    const rows = [];
    for (const entry of records) {
      if (!entry.userId) continue;
      if (members.size > 0 && !members.has(entry.userId)) continue;
      const record = await store.load(resolvedScopeId, entry.userId);
      const name2 = record?.nickname || entry.nickname || entry.userId;
      const affinity = config.affinityDynamics?.disableAffinityCoefficient === true ? Number(record?.longTermAffinity ?? record?.affinity ?? 0) : Number(record?.affinity ?? 0);
      if (entry.mode === "temporary") {
        rows.push(
          `name:${name2} | id:${entry.userId} | affinity:${affinity} | mode:temporary | blockedAt:${entry.blockedAt} | expiresAt:${entry.expiresAt || ""}`
        );
        continue;
      }
      rows.push(
        `name:${name2} | id:${entry.userId} | affinity:${affinity} | mode:permanent | blockedAt:${entry.blockedAt}`
      );
    }
    return rows.join("\n");
  };
}

// src/commands/rank.ts
var import_koishi6 = require("koishi");
function registerRankCommand(deps) {
  const {
    ctx,
    config,
    renders,
    fetchGroupMemberIds: fetchGroupMemberIds2,
    resolveUserIdentity: resolveUserIdentity2,
    resolveGroupId: resolveGroupId2,
    stripAtPrefix: stripAtPrefix2
  } = deps;
  ctx.command(
    buildScopedCommandName(config.scopeId, "rank") + " [limit:number] [image]",
    "\u67E5\u770B\u5F53\u524D\u597D\u611F\u5EA6\u6392\u884C",
    {
      authority: 1
    }
  ).alias("\u597D\u611F\u5EA6\u6392\u884C").action(async ({ session }, limitArg, imageArg) => {
    const parsedLimit = Number(limitArg);
    const limit = Math.max(
      1,
      Math.min(
        Number.isFinite(parsedLimit) ? parsedLimit : config.rankDefaultLimit,
        50
      )
    );
    const groupId = resolveGroupId2(session);
    const shouldRenderImage = imageArg === void 0 ? !!config.rankRenderAsImage : !["0", "false", "text", "no", "n"].includes(
      String(imageArg).toLowerCase()
    );
    let scopedRows = [];
    if (groupId) {
      const memberIds = await fetchGroupMemberIds2(session);
      if (!memberIds || memberIds.size === 0) {
        return "\u65E0\u6CD5\u83B7\u53D6\u672C\u7FA4\u6210\u5458\u5217\u8868\uFF0C\u6682\u65F6\u65E0\u6CD5\u5C55\u793A\u6392\u884C\u3002";
      }
      const rows = await ctx.database.select(MODEL_NAME_V2).where({ scopeId: config.scopeId }).orderBy("affinity", "desc").execute();
      scopedRows = rows.filter((row) => memberIds.has(stripAtPrefix2(row.userId))).slice(0, limit);
      if (!scopedRows.length) return "\u672C\u7FA4\u6682\u65E0\u597D\u611F\u5EA6\u8BB0\u5F55\u3002";
    } else {
      const rows = await ctx.database.select(MODEL_NAME_V2).where({ scopeId: config.scopeId }).orderBy("affinity", "desc").limit(limit).execute();
      if (!rows.length) return "\u5F53\u524D\u6682\u65E0\u597D\u611F\u5EA6\u8BB0\u5F55\u3002";
      scopedRows = rows;
    }
    const lines = await Promise.all(
      scopedRows.map(async (row) => {
        let name2 = row.nickname || row.userId;
        if (groupId) {
          const resolved = await resolveUserIdentity2(
            session,
            row.userId
          );
          if (resolved?.nickname && resolved.nickname !== row.userId) {
            name2 = resolved.nickname;
          }
        }
        return {
          name: name2,
          relation: row.specialRelation || row.relation || "\u2014\u2014",
          affinity: config.affinityDynamics?.disableAffinityCoefficient === true ? row.longTermAffinity ?? row.affinity : row.affinity,
          userId: row.userId
        };
      })
    );
    const textLines = [
      "\u7FA4\u6635\u79F0 \u5173\u7CFB \u597D\u611F\u5EA6",
      ...lines.map(
        (item, index) => `${index + 1}. ${item.name} ${item.relation} ${item.affinity}`
      )
    ];
    if (shouldRenderImage) {
      const rankItems = lines.map((item, index) => {
        const rawId = stripAtPrefix2(item.userId);
        const idParts = rawId.split(":");
        const id = idParts.length > 1 ? idParts[1] : idParts[0];
        const numericId = id.match(/^\d+$/) ? id : void 0;
        const avatarUrl = numericId ? `https://q1.qlogo.cn/g?b=qq&nk=${numericId}&s=640` : void 0;
        return {
          rank: index + 1,
          name: item.name,
          relation: item.relation,
          affinity: item.affinity,
          avatarUrl
        };
      });
      const buffer = await renders.rankList("\u597D\u611F\u5EA6\u6392\u884C", rankItems);
      if (buffer) return import_koishi6.h.image(buffer, "image/png");
      return textLines.join("\n");
    }
    return textLines.join("\n");
  });
}

// src/commands/inspect.ts
var import_koishi7 = require("koishi");
function registerInspectCommand(deps) {
  const { ctx, config, store, renders, fetchMember: fetchMember2, stripAtPrefix: stripAtPrefix2 } = deps;
  ctx.command(
    buildScopedCommandName(config.scopeId, "inspect") + " [targetUserId:string] [platform:string] [image]",
    "\u67E5\u770B\u6307\u5B9A\u7528\u6237\u7684\u597D\u611F\u5EA6\u8BE6\u60C5",
    { authority: 1 }
  ).alias("\u597D\u611F\u5EA6\u8BE6\u60C5").action(async ({ session }, targetUserArg, platformArg, imageArg) => {
    const platform = platformArg || session?.platform || "";
    const userId = targetUserArg || session?.userId || "";
    const selfId = session?.selfId || "";
    if (!userId) return "\u8BF7\u63D0\u4F9B\u7528\u6237 ID\u3002";
    const record = await store.load(config.scopeId, userId);
    if (!record) return "\u672A\u627E\u5230\u597D\u611F\u5EA6\u8BB0\u5F55\u3002";
    const state = store.extractState(record);
    const coefficient = state.coefficientState?.coefficient ?? config.affinityDynamics?.coefficient?.base ?? 1;
    const coefficientDisabled = config.affinityDynamics?.disableAffinityCoefficient === true;
    const shortTermDisabled = config.affinityDynamics?.disableShortTermAffinity === true;
    const currentCompositeAffinity = coefficientDisabled ? state.longTermAffinity : Math.round(coefficient * state.longTermAffinity);
    const showImpression = config.inspectShowImpression !== false;
    const shouldRenderImage = imageArg === void 0 ? !!config.inspectRenderAsImage : !["0", "false", "text", "no", "n"].includes(
      String(imageArg).toLowerCase()
    );
    let displayNickname = record.nickname || userId;
    if (session) {
      const memberInfo = await fetchMember2(session, userId);
      if (memberInfo) {
        const raw = memberInfo;
        const card = raw.card || raw.user?.card;
        const nick = raw.nickname || raw.nick || raw.user?.nickname || raw.user?.nick;
        const resolved = String(card || nick || "").trim();
        if (resolved) displayNickname = resolved;
      }
    }
    let impression;
    if (showImpression) {
      const analysisService = ctx.chatluna_group_analysis;
      if (analysisService?.getUserPersona) {
        try {
          const persona = await analysisService.getUserPersona(
            platform,
            selfId,
            stripAtPrefix2(userId)
          );
          if (persona?.profile?.summary) {
            impression = persona.profile.summary;
          }
        } catch {
        }
      }
    }
    const displayRelation = record.specialRelation || record.relation || "\u2014\u2014";
    const lines = [
      `\u7528\u6237\uFF1A${displayNickname} ${stripAtPrefix2(userId)}`,
      `\u5173\u7CFB\uFF1A${displayRelation}`,
      `\u597D\u611F\u5EA6\uFF1A${currentCompositeAffinity}`,
      `\u957F\u671F\u597D\u611F\u5EA6\uFF1A${state.longTermAffinity}`,
      `\u77ED\u671F\u597D\u611F\u5EA6\uFF1A${shortTermDisabled ? 0 : state.shortTermAffinity}`,
      `\u597D\u611F\u5EA6\u7CFB\u6570\uFF1A${coefficientDisabled ? "\u5DF2\u5173\u95ED" : `${coefficient.toFixed(2)}\uFF08\u8FDE\u7EED\u4E92\u52A8 ${state.coefficientState?.streak ?? 0} \u5929\uFF09`}`,
      `\u4E92\u52A8\u7EDF\u8BA1\uFF1A\u603B\u8BA1 ${state.chatCount} \u6B21`,
      `\u6700\u540E\u4E92\u52A8\uFF1A${formatTimestamp(state.lastInteractionAt)}`,
      ...showImpression && impression ? [`\u5370\u8C61\uFF1A${impression}`] : []
    ];
    if (shouldRenderImage) {
      const rawId = stripAtPrefix2(userId);
      const idParts = rawId.split(":");
      const id = idParts.length > 1 ? idParts[1] : idParts[0];
      const numericId = id.match(/^\d+$/) ? id : void 0;
      const avatarUrl = numericId ? `https://q1.qlogo.cn/g?b=qq&nk=${numericId}&s=640` : void 0;
      const displayPlatform = platform === "onebot" ? "" : platform;
      const buffer = await renders.inspect({
        userId: stripAtPrefix2(userId),
        nickname: displayNickname,
        platform: displayPlatform,
        relation: displayRelation,
        compositeAffinity: currentCompositeAffinity,
        longTermAffinity: state.longTermAffinity,
        shortTermAffinity: state.shortTermAffinity,
        coefficient,
        streak: state.coefficientState?.streak ?? 0,
        chatCount: state.chatCount,
        lastInteraction: formatTimestamp(state.lastInteractionAt),
        avatarUrl,
        impression: showImpression ? impression : void 0
      });
      if (buffer) return import_koishi7.h.image(buffer, "image/png");
    }
    return lines.join("\n");
  });
}

// src/commands/blacklist.ts
var import_koishi8 = require("koishi");
async function enrichBlacklistRecords(records, session, deps) {
  const { resolveUserIdentity: resolveUserIdentity2, stripAtPrefix: stripAtPrefix2 } = deps;
  return Promise.all(
    records.map(async (entry) => {
      const sanitizedId = stripAtPrefix2(entry?.userId);
      let nickname = stripAtPrefix2(entry?.nickname || "");
      let userId = sanitizedId;
      if (!nickname || nickname === sanitizedId) {
        const resolved = await resolveUserIdentity2(session, sanitizedId);
        if (resolved) {
          userId = resolved.userId || sanitizedId;
          nickname = resolved.nickname || sanitizedId;
        }
      }
      return { ...entry, userId, nickname };
    })
  );
}
function registerBlacklistCommand(deps) {
  const {
    ctx,
    config,
    renders,
    blacklist,
    stripAtPrefix: stripAtPrefix2,
    fetchGroupMemberIds: fetchGroupMemberIds2,
    resolveGroupId: resolveGroupId2
  } = deps;
  ctx.command(
    buildScopedCommandName(config.scopeId, "blacklist") + " [limit:number] [platform:string] [image]",
    "\u67E5\u770B\u9ED1\u540D\u5355\u5217\u8868",
    { authority: 2 }
  ).alias("\u9ED1\u540D\u5355").action(async ({ session }, limitArg, platformArg, imageArg) => {
    const parsedLimit = Number(limitArg);
    const limit = Math.max(
      1,
      Math.min(
        Number.isFinite(parsedLimit) ? parsedLimit : config.blacklistDefaultLimit,
        100
      )
    );
    const shouldRenderImage = imageArg === void 0 ? !!config.blacklistRenderAsImage : !["0", "false", "text", "no", "n"].includes(
      String(imageArg).toLowerCase()
    );
    const platform = platformArg || session?.platform;
    const groupId = session ? resolveGroupId2(session) : "";
    const memberIds = groupId && session ? await fetchGroupMemberIds2(session) : null;
    if (groupId && (!memberIds || memberIds.size === 0)) {
      return "\u65E0\u6CD5\u83B7\u53D6\u672C\u7FA4\u6210\u5458\u5217\u8868\uFF0C\u6682\u65F6\u65E0\u6CD5\u5C55\u793A\u9ED1\u540D\u5355\u3002";
    }
    const permanentRecords = await blacklist.listPermanent(platform);
    const tempRecords = await blacklist.listTemporary(platform);
    const merged = [
      ...permanentRecords.filter((r) => !memberIds || memberIds.has(stripAtPrefix2(r.userId))).map((r) => ({ ...r, isTemp: false })),
      ...tempRecords.filter((r) => !memberIds || memberIds.has(stripAtPrefix2(r.userId))).map((r) => ({
        userId: r.userId,
        nickname: r.nickname,
        blockedAt: r.blockedAt,
        note: r.note,
        isTemp: true,
        expiresAt: r.expiresAt,
        durationHours: Number(r.durationHours) || void 0,
        penalty: Number(r.penalty) || void 0
      }))
    ];
    if (!merged.length) return "\u5F53\u524D\u6682\u65E0\u62C9\u9ED1\u8BB0\u5F55\u3002";
    const limited = merged.slice(0, limit);
    const enriched = await enrichBlacklistRecords(
      limited,
      session,
      deps
    );
    const textLines = [
      "# \u6635\u79F0 \u7528\u6237ID \u7C7B\u578B \u65F6\u95F4 \u5907\u6CE8",
      ...enriched.map((item, index) => {
        const note = item.note ? item.note : "\u2014\u2014";
        const time = item.isTemp ? item.expiresAt || "\u2014\u2014" : item.blockedAt || "\u2014\u2014";
        const nickname = stripAtPrefix2(item.nickname || item.userId);
        const userIdDisplay = stripAtPrefix2(item.userId);
        const tag = item.isTemp ? "[\u4E34\u65F6]" : "[\u6C38\u4E45]";
        return `${index + 1}. ${nickname} ${userIdDisplay} ${tag} ${time} ${note}`;
      })
    ];
    if (shouldRenderImage) {
      const items = enriched.map((item, index) => ({
        index: index + 1,
        nickname: stripAtPrefix2(item.nickname || item.userId),
        userId: stripAtPrefix2(item.userId),
        timeInfo: item.isTemp ? `\u5230\u671F: ${item.expiresAt || "\u2014\u2014"}` : item.blockedAt || "\u2014\u2014",
        note: item.note || "\u2014\u2014",
        isTemp: item.isTemp,
        penalty: item.penalty,
        tag: item.isTemp ? "\u4E34\u65F6" : "\u6C38\u4E45",
        avatarUrl: (() => {
          const rawId = stripAtPrefix2(item.userId);
          const numericId = rawId.match(/^\d+$/) ? rawId : void 0;
          return numericId ? `https://q1.qlogo.cn/g?b=qq&nk=${numericId}&s=640` : void 0;
        })()
      }));
      const buffer = await renders.blacklist("\u9ED1\u540D\u5355", items);
      if (buffer) return import_koishi8.h.image(buffer, "image/png");
      return textLines.join("\n");
    }
    return textLines.join("\n");
  });
}

// src/commands/block.ts
function registerBlockCommand(deps) {
  const {
    ctx,
    cache,
    blacklist,
    resolveUserIdentity: resolveUserIdentity2,
    stripAtPrefix: stripAtPrefix2,
    fetchMember: fetchMember2,
    unblockPermanent
  } = deps;
  ctx.command(
    buildScopedCommandName(deps.config.scopeId, "block") + " <userId:string> [platform:string]",
    "\u624B\u52A8\u5C06\u7528\u6237\u52A0\u5165\u9ED1\u540D\u5355",
    { authority: 4 }
  ).option("note", "-n <note:text> \u5907\u6CE8\u4FE1\u606F").alias("\u62C9\u9ED1\u4EBA").action(async ({ session, options }, userId, platformArg) => {
    const platform = platformArg || session?.platform;
    if (!platform) return "\u8BF7\u6307\u5B9A\u5E73\u53F0\u3002";
    const resolved = await resolveUserIdentity2(session, userId);
    const normalizedUserId = resolved?.userId || stripAtPrefix2(userId);
    if (!normalizedUserId) return "\u7528\u6237 ID \u4E0D\u80FD\u4E3A\u7A7A\u3002";
    if (await blacklist.isBlacklisted(platform, normalizedUserId)) {
      return `${platform}/${normalizedUserId} \u5DF2\u5728\u6C38\u4E45\u9ED1\u540D\u5355\u4E2D\u3002`;
    }
    const note = options?.note || "manual";
    await blacklist.recordPermanent(platform, normalizedUserId, {
      note,
      nickname: resolved?.nickname || normalizedUserId
    });
    cache.clear(deps.config.scopeId, normalizedUserId);
    const nicknameDisplay = resolved?.nickname || normalizedUserId;
    return `\u5DF2\u5C06 ${nicknameDisplay} (${normalizedUserId}) \u52A0\u5165\u6C38\u4E45\u9ED1\u540D\u5355\u3002`;
  });
  ctx.command(
    buildScopedCommandName(deps.config.scopeId, "unblock") + " <userId:string> [platform:string]",
    "\u89E3\u9664\u6C38\u4E45\u9ED1\u540D\u5355",
    { authority: 4 }
  ).alias("\u89E3\u9664\u62C9\u9ED1").action(async ({ session }, userId, platformArg) => {
    const platform = platformArg || session?.platform;
    if (!platform) return "\u8BF7\u6307\u5B9A\u5E73\u53F0\u3002";
    const normalizedUserId = stripAtPrefix2(userId);
    if (!normalizedUserId) return "\u7528\u6237 ID \u4E0D\u80FD\u4E3A\u7A7A\u3002";
    const result = await unblockPermanent({
      source: "command",
      platform,
      userId: normalizedUserId,
      seed: session ? {
        scopeId: deps.config.scopeId,
        platform,
        userId: normalizedUserId,
        session
      } : {
        scopeId: deps.config.scopeId,
        platform,
        userId: normalizedUserId
      }
    });
    if (result.removed && result.affinityReset) {
      let nickname = normalizedUserId;
      if (session) {
        const memberInfo = await fetchMember2(
          session,
          normalizedUserId
        );
        if (memberInfo) {
          const raw = memberInfo;
          const card = raw.card || raw.user?.card;
          const nick = raw.nickname || raw.nick || raw.user?.nickname;
          nickname = String(card || nick || normalizedUserId).trim();
        }
      }
      return `\u5DF2\u89E3\u9664 ${nickname}(${normalizedUserId}) \u7684\u6C38\u4E45\u9ED1\u540D\u5355\uFF0C\u5E76\u5C06\u597D\u611F\u5EA6\u91CD\u7F6E\u4E3A ${result.affinity ?? "\u914D\u7F6E\u503C"}\u3002`;
    }
    return `${normalizedUserId} \u4E0D\u5728\u6C38\u4E45\u9ED1\u540D\u5355\u4E2D\uFF0C\u6216\u5F53\u524D\u4E0A\u4E0B\u6587\u65E0\u6CD5\u5B8C\u6210\u597D\u611F\u5EA6\u91CD\u7F6E\u3002`;
  });
}

// src/commands/temp-block.ts
function registerTempBlockCommand(deps) {
  const {
    ctx,
    config,
    store,
    cache,
    blacklist,
    resolveUserIdentity: resolveUserIdentity2,
    stripAtPrefix: stripAtPrefix2,
    fetchMember: fetchMember2
  } = deps;
  ctx.command(
    buildScopedCommandName(deps.config.scopeId, "tempBlock") + " <userId:string> [durationHours:number] [platform:string]",
    "\u4E34\u65F6\u62C9\u9ED1\u7528\u6237",
    { authority: 4 }
  ).option("note", "-n <note:text> \u5907\u6CE8\u4FE1\u606F").option("penalty", "-p <penalty:number> \u6263\u9664\u597D\u611F\u5EA6").alias("\u4E34\u65F6\u62C9\u9ED1").action(async ({ session, options }, userId, durationArg, platformArg) => {
    const platform = platformArg || session?.platform;
    if (!platform) return "\u8BF7\u6307\u5B9A\u5E73\u53F0\u3002";
    const resolved = await resolveUserIdentity2(session, userId);
    const normalizedUserId = resolved?.userId || stripAtPrefix2(userId);
    if (!normalizedUserId) return "\u7528\u6237 ID \u4E0D\u80FD\u4E3A\u7A7A\u3002";
    const parsedDuration = Number(durationArg);
    const durationHours = Number.isFinite(parsedDuration) ? Math.max(1, parsedDuration) : 12;
    const penalty = options?.penalty ?? config.shortTermBlacklistPenalty ?? 5;
    const existing = await blacklist.isTemporarilyBlacklisted(
      platform,
      normalizedUserId
    );
    if (existing) {
      return `${platform}/${normalizedUserId} \u5DF2\u5728\u4E34\u65F6\u9ED1\u540D\u5355\u4E2D\uFF0C\u5230\u671F\u65F6\u95F4\uFF1A${existing.expiresAt}`;
    }
    const entry = await blacklist.recordTemporary(
      platform,
      normalizedUserId,
      durationHours,
      penalty,
      {
        note: options?.note || "manual",
        nickname: resolved?.nickname || normalizedUserId
      }
    );
    if (!entry) return `\u6DFB\u52A0\u4E34\u65F6\u9ED1\u540D\u5355\u5931\u8D25\u3002`;
    if (penalty > 0) {
      try {
        const record = await store.load(
          deps.config.scopeId,
          normalizedUserId
        );
        if (record) {
          const newAffinity = store.clamp(
            (record.longTermAffinity ?? record.affinity) - penalty
          );
          await store.save(
            {
              scopeId: deps.config.scopeId,
              platform,
              userId: normalizedUserId,
              session
            },
            newAffinity,
            record.specialRelation || ""
          );
        }
      } catch {
      }
    }
    cache.clear(deps.config.scopeId, normalizedUserId);
    const nicknameDisplay = resolved?.nickname || normalizedUserId;
    return `\u5DF2\u5C06 ${nicknameDisplay} (${normalizedUserId}) \u52A0\u5165\u4E34\u65F6\u9ED1\u540D\u5355\uFF0C\u65F6\u957F ${durationHours} \u5C0F\u65F6\uFF0C\u6263\u9664\u597D\u611F\u5EA6 ${penalty}\u3002`;
  });
  ctx.command(
    buildScopedCommandName(deps.config.scopeId, "tempUnblock") + " <userId:string> [platform:string]",
    "\u89E3\u9664\u4E34\u65F6\u62C9\u9ED1",
    { authority: 4 }
  ).alias("\u89E3\u9664\u4E34\u65F6\u62C9\u9ED1").action(async ({ session }, userId, platformArg) => {
    const platform = platformArg || session?.platform;
    if (!platform) return "\u8BF7\u6307\u5B9A\u5E73\u53F0\u3002";
    const normalizedUserId = stripAtPrefix2(userId);
    if (!normalizedUserId) return "\u7528\u6237 ID \u4E0D\u80FD\u4E3A\u7A7A\u3002";
    const removed = await blacklist.removeTemporary(
      platform,
      normalizedUserId
    );
    cache.clear(deps.config.scopeId, normalizedUserId);
    if (removed) {
      let nickname = normalizedUserId;
      if (session) {
        const memberInfo = await fetchMember2(
          session,
          normalizedUserId
        );
        if (memberInfo) {
          const raw = memberInfo;
          const card = raw.card || raw.user?.card;
          const nick = raw.nickname || raw.nick || raw.user?.nickname;
          nickname = String(card || nick || normalizedUserId).trim();
        }
      }
      return `\u5DF2\u89E3\u9664 ${nickname}(${normalizedUserId}) \u7684\u4E34\u65F6\u9ED1\u540D\u5355\u3002`;
    }
    return `${normalizedUserId} \u4E0D\u5728\u4E34\u65F6\u9ED1\u540D\u5355\u4E2D\u3002`;
  });
}

// src/commands/clear-all.ts
function registerClearAllCommand(deps) {
  const { ctx, log, cache, config } = deps;
  const pendingClearConfirmations = /* @__PURE__ */ new Map();
  ctx.command(
    buildScopedCommandName(config.scopeId, "clearAll"),
    "\u6E05\u7A7A\u5F53\u524D\u4F5C\u7528\u57DF\u7684\u597D\u611F\u5EA6\u6570\u636E\uFF08\u5371\u9669\u64CD\u4F5C\uFF09",
    {
      authority: 4
    }
  ).alias("\u6E05\u7A7A\u597D\u611F\u5EA6").option("confirm", "-y \u786E\u8BA4\u6E05\u7A7A").action(async ({ session, options }) => {
    if (!session) return "\u65E0\u6CD5\u83B7\u53D6\u4F1A\u8BDD\u4FE1\u606F\u3002";
    const sessionKey = `${session.platform}:${session.userId}`;
    const now = Date.now();
    const pending = pendingClearConfirmations.get(sessionKey);
    if (pending && pending.expiresAt > now && options?.confirm) {
      pendingClearConfirmations.delete(sessionKey);
      try {
        await ctx.database.remove(MODEL_NAME_V2, { scopeId: config.scopeId });
        await ctx.database.remove(BLACKLIST_MODEL_NAME_V2, {
          scopeId: config.scopeId
        });
        await ctx.database.remove(USER_ALIAS_MODEL_NAME_V2, {
          scopeId: config.scopeId
        });
        await ctx.database.remove(DASHBOARD_SNAPSHOT_MODEL_NAME, {
          scopeId: config.scopeId
        });
        await ctx.database.remove(USER_AFFINITY_SNAPSHOT_MODEL_NAME, {
          scopeId: config.scopeId
        });
        cache.clearAll?.();
        log("info", "\u5F53\u524D\u4F5C\u7528\u57DF\u6570\u636E\u5E93\u5DF2\u6E05\u7A7A", {
          scopeId: config.scopeId,
          operator: session.userId,
          platform: session.platform
        });
        return `\u2705 \u5DF2\u6210\u529F\u6E05\u7A7A\u4F5C\u7528\u57DF ${config.scopeId} \u4E0B\u7684\u597D\u611F\u5EA6\u3001\u9ED1\u540D\u5355\u3001\u6635\u79F0\u4E0E\u8D8B\u52BF\u5FEB\u7167\u6570\u636E\u3002`;
      } catch (error) {
        log("warn", "\u6E05\u7A7A\u6570\u636E\u5E93\u5931\u8D25", error);
        return "\u274C \u6E05\u7A7A\u6570\u636E\u5E93\u65F6\u53D1\u751F\u9519\u8BEF\uFF0C\u8BF7\u67E5\u770B\u65E5\u5FD7\u3002";
      }
    }
    pendingClearConfirmations.set(sessionKey, { expiresAt: now + 60 * 1e3 });
    return `\u26A0\uFE0F \u8B66\u544A\uFF1A\u6B64\u64CD\u4F5C\u5C06\u6C38\u4E45\u5220\u9664\u4F5C\u7528\u57DF ${config.scopeId} \u4E0B\u7684\u597D\u611F\u5EA6\u3001\u9ED1\u540D\u5355\u3001\u6635\u79F0\u4E0E\u8D8B\u52BF\u5FEB\u7167\u6570\u636E\uFF0C\u4E14\u65E0\u6CD5\u6062\u590D\uFF01
\u8BF7\u5728 60 \u79D2\u5185\u4F7F\u7528 \`${buildScopedCommandName(config.scopeId, "clearAll")} -y\` \u6216 \`\u6E05\u7A7A\u597D\u611F\u5EA6 -y\` \u786E\u8BA4\u6267\u884C\u3002`;
  });
}

// src/commands/adjust.ts
function registerAdjustCommand(deps) {
  const { ctx, store, log, resolveUserIdentity: resolveUserIdentity2, stripAtPrefix: stripAtPrefix2 } = deps;
  ctx.command(
    buildScopedCommandName(deps.config.scopeId, "adjust") + " <target:string> <delta:number>",
    "\u8C03\u6574\u6307\u5B9A\u7528\u6237\u7684\u597D\u611F\u5EA6",
    { authority: 4 }
  ).alias("\u8C03\u6574\u597D\u611F").alias("\u8C03\u6574\u597D\u611F\u5EA6").option("set", "-s \u76F4\u63A5\u8BBE\u7F6E\u597D\u611F\u5EA6\u503C\u800C\u975E\u589E\u51CF").usage(
    "\u793A\u4F8B\uFF1Aaffinity.adjust @\u7528\u6237 10\uFF08\u589E\u52A010\u70B9\uFF09\n\u793A\u4F8B\uFF1Aaffinity.adjust @\u7528\u6237 -5\uFF08\u51CF\u5C115\u70B9\uFF09\n\u793A\u4F8B\uFF1Aaffinity.adjust @\u7528\u6237 50 -s\uFF08\u8BBE\u7F6E\u4E3A50\uFF09"
  ).action(async ({ session, options }, target, delta) => {
    if (!session) return "\u65E0\u6CD5\u83B7\u53D6\u4F1A\u8BDD\u4FE1\u606F";
    if (!target) return "\u8BF7\u6307\u5B9A\u76EE\u6807\u7528\u6237";
    const parsedDelta = Number(delta);
    if (!Number.isFinite(parsedDelta)) {
      return "\u8BF7\u6307\u5B9A\u6709\u6548\u7684\u597D\u611F\u5EA6\u53D8\u5316\u503C";
    }
    const identity = await resolveUserIdentity2(session, target);
    const userId = identity?.userId || stripAtPrefix2(target);
    const nickname = identity?.nickname || userId;
    const existing = await store.load(deps.config.scopeId, userId);
    const currentAffinity = existing?.longTermAffinity ?? existing?.affinity ?? store.defaultInitial();
    const newAffinity = options?.set ? parsedDelta : currentAffinity + parsedDelta;
    const clampedAffinity = store.clamp(newAffinity);
    await store.save(
      { scopeId: deps.config.scopeId, userId, nickname },
      clampedAffinity,
      existing?.specialRelation || "",
      {
        longTermAffinity: clampedAffinity,
        shortTermAffinity: existing?.shortTermAffinity ?? 0
      }
    );
    const action = options?.set ? "\u8BBE\u7F6E" : parsedDelta >= 0 ? "\u589E\u52A0" : "\u51CF\u5C11";
    const changeText = options?.set ? `${clampedAffinity}` : `${Math.abs(parsedDelta)}`;
    log("info", "\u624B\u52A8\u8C03\u6574\u597D\u611F\u5EA6", {
      scopeId: deps.config.scopeId,
      userId,
      nickname,
      action,
      change: parsedDelta,
      before: currentAffinity,
      after: clampedAffinity
    });
    return `\u5DF2${action} ${nickname}(${stripAtPrefix2(userId)}) \u7684\u597D\u611F\u5EA6 ${changeText}
\u8C03\u6574\u524D\uFF1A${currentAffinity} \u2192 \u8C03\u6574\u540E\uFF1A${clampedAffinity}`;
  });
}

// src/plugin.ts
function normalizeToolSettings(config) {
  const nativeToolSettings = {
    enabledNativeTools: config.nativeToolSettings?.enabledNativeTools ?? [],
    affinity: {
      toolName: config.nativeToolSettings?.affinity?.toolName || "affinity_affinity",
      description: config.nativeToolSettings?.affinity?.description || DEFAULT_AFFINITY_NATIVE_TOOL_DESCRIPTION
    },
    blacklist: {
      toolName: config.nativeToolSettings?.blacklist?.toolName || "affinity_blacklist",
      description: config.nativeToolSettings?.blacklist?.description || DEFAULT_BLACKLIST_NATIVE_TOOL_DESCRIPTION
    },
    relationship: {
      toolName: config.nativeToolSettings?.relationship?.toolName || "affinity_relationship",
      description: config.nativeToolSettings?.relationship?.description || DEFAULT_RELATIONSHIP_NATIVE_TOOL_DESCRIPTION
    },
    userAlias: {
      toolName: config.nativeToolSettings?.userAlias?.toolName || "affinity_user_alias",
      description: config.nativeToolSettings?.userAlias?.description || DEFAULT_USER_ALIAS_NATIVE_TOOL_DESCRIPTION
    }
  };
  const xmlToolSettings = {
    injectXmlToolAsReplyTool: config.xmlToolSettings?.injectXmlToolAsReplyTool ?? config.injectXmlToolAsReplyTool ?? false,
    enableAffinityXmlToolCall: config.xmlToolSettings?.enableAffinityXmlToolCall ?? true,
    enableBlacklistXmlToolCall: config.xmlToolSettings?.enableBlacklistXmlToolCall ?? true,
    enableRelationshipXmlToolCall: config.xmlToolSettings?.enableRelationshipXmlToolCall ?? true,
    enableUserAliasXmlToolCall: config.xmlToolSettings?.enableUserAliasXmlToolCall ?? true,
    autoInjectReferencePrompt: config.xmlToolSettings?.autoInjectReferencePrompt ?? config.autoInjectReferencePrompt ?? false,
    characterPromptTemplate: config.xmlToolSettings?.characterPromptTemplate || config.characterPromptTemplate || ""
  };
  const variableSettings = {
    affinityVariableName: config.variableSettings?.affinityVariableName || config.affinityVariableName || "affinity",
    showChatCountInAffinityVariable: config.variableSettings?.showChatCountInAffinityVariable ?? config.showChatCountInAffinityVariable ?? true,
    relationshipLevelVariableName: config.variableSettings?.relationshipLevelVariableName || config.relationshipLevelVariableName || "relationshipLevel",
    blacklistListVariableName: config.variableSettings?.blacklistListVariableName || config.blacklistListVariableName || "blacklistList"
  };
  config.nativeToolSettings = nativeToolSettings;
  config.xmlToolSettings = xmlToolSettings;
  config.variableSettings = variableSettings;
}
function apply(ctx, config) {
  const runtimeFingerprint = "chatluna-affinity fingerprint: 2026-03-08-runtime-check-a";
  config.scopeId = assertScopeId(config.scopeId);
  config.initialAffinity = Number.isFinite(config.initialAffinity) ? Number(config.initialAffinity) : BASE_AFFINITY_DEFAULTS.initialAffinity;
  config.autoInjectAffinityMechanismPrompt = config.autoInjectAffinityMechanismPrompt !== false;
  normalizeToolSettings(config);
  registerModels(ctx);
  const log = createLogger(ctx, config);
  registerDashboardBackend({
    ctx,
    config,
    log
  });
  registerDashboardWebui({
    ctx,
    config,
    log,
    entry: {
      dev: path.resolve(__dirname, "../client/index.ts"),
      prod: path.resolve(__dirname, "../dist")
    }
  });
  log("info", runtimeFingerprint);
  log(
    "warn",
    "\u26A0\uFE0F \u5347\u7EA7\u63D0\u793A\uFF1A\u5DF2\u542F\u7528 v2 \u6570\u636E\u8868\u4E0E\u8FC1\u79FB\u903B\u8F91\u3002\u65E7\u8868\u6570\u636E\u4F1A\u8FC1\u79FB\u5230\u65B0\u8868\uFF0C\u82E5\u9700\u67E5\u770B\u65E7\u8868\u8BF7\u76F4\u63A5\u4F7F\u7528\u6570\u636E\u5E93\u5DE5\u5177\u3002"
  );
  const cache = createAffinityCache();
  const store = createAffinityStore({
    ctx,
    config,
    log
  });
  const migration = createMigrationService({
    ctx,
    scopeId: config.scopeId,
    log
  });
  const shortTermConfig = resolveShortTermConfig(config);
  const actionWindowConfig = resolveActionWindowConfig(config);
  const coefficientConfig = resolveCoefficientConfig(config);
  const history = createMessageHistory({ ctx, config, log });
  const manualRelationship = createManualRelationshipManager({
    ctx,
    config,
    log
  });
  const blacklist = createBlacklistService({
    ctx,
    config,
    log
  });
  const unblockPermanent = createPermanentUnblockHandler({
    config,
    log,
    store,
    cache,
    blacklist
  });
  const userAlias = createUserAliasService({
    ctx,
    scopeId: config.scopeId,
    log
  });
  const renders = createRenderService({ log });
  ctx.accept(
    ["relationships"],
    () => {
      manualRelationship.syncToDatabase().catch((error) => log("warn", "\u540C\u6B65\u7279\u6B8A\u5173\u7CFB\u914D\u7F6E\u5230\u6570\u636E\u5E93\u5931\u8D25", error));
    },
    { passive: true }
  );
  const blacklistGuard = createBlacklistGuard({
    config,
    blacklist,
    log
  });
  ctx.middleware(
    blacklistGuard.middleware,
    true
  );
  let characterCtx = null;
  let xmlActionExecutionEnabled = true;
  let replyToolsDispose = null;
  let nativeToolsDispose = null;
  let referencePromptDispose = null;
  let affinityMechanismPromptDispose = null;
  let isOnlyScope = false;
  let isScopeOwner = false;
  let servicesInitialized = false;
  let reconcileNativeTools = null;
  let reconcileCharacterTools = null;
  let reconcileReferencePrompt = null;
  let reconcileAffinityMechanismPrompt = null;
  const scopeDispose = registerActiveScope(ctx, config.scopeId, (state) => {
    isOnlyScope = state.isOnlyScope;
    isScopeOwner = state.isOwner;
    reconcileNativeTools?.();
    if (servicesInitialized) reconcileCharacterTools?.();
    reconcileReferencePrompt?.();
    reconcileAffinityMechanismPrompt?.();
  });
  const processModelResponse = createModelResponseProcessor({
    config,
    cache,
    store,
    blacklist,
    unblockPermanent,
    userAlias,
    shortTermConfig,
    actionWindowConfig,
    coefficientConfig,
    shouldExecuteXmlActions: () => xmlActionExecutionEnabled,
    log
  });
  const modelResponseRuntime = createCharacterTempModelResponseRuntime({
    getCharacterService: () => (characterCtx ?? ctx).chatluna_character,
    processModelResponse,
    log,
    logActivation: Boolean(config.debugLogging)
  });
  reconcileCharacterTools = () => {
    replyToolsDispose?.();
    replyToolsDispose = null;
    xmlActionExecutionEnabled = true;
    if (!characterCtx || !isOnlyScope || !isScopeOwner) return;
    if (!hasReplyToolsEnabled(config)) return;
    const characterService = characterCtx.chatluna_character;
    if (!characterService?.registerReplyToolField) {
      if (config.debugLogging) {
        log(
          "warn",
          "chatluna_character.registerReplyToolField \u4E0D\u53EF\u7528\uFF0C\u56DE\u9000\u4E3A XML \u52A8\u4F5C\u6267\u884C\u6A21\u5F0F"
        );
      }
      return;
    }
    replyToolsDispose = registerCharacterReplyTools({
      ctx: characterCtx,
      config,
      cache,
      store,
      blacklist,
      unblockPermanent,
      userAlias,
      shortTermConfig,
      actionWindowConfig,
      coefficientConfig,
      log
    });
    xmlActionExecutionEnabled = false;
    if (config.debugLogging) {
      log("info", "\u5DF2\u542F\u7528\u5B9E\u9A8C\u6027 reply tool \u5B57\u6BB5\u6CE8\u5165\uFF0C\u5173\u95ED XML \u52A8\u4F5C\u6267\u884C");
    }
  };
  reconcileReferencePrompt = () => {
    referencePromptDispose?.();
    referencePromptDispose = null;
    if (!isScopeOwner && isOnlyScope) return;
    referencePromptDispose = registerCharacterPromptInjection({
      ctx,
      config,
      replaceScopeId: isOnlyScope,
      log
    });
  };
  reconcileAffinityMechanismPrompt = () => {
    affinityMechanismPromptDispose?.();
    affinityMechanismPromptDispose = null;
    if (!isScopeOwner && isOnlyScope) return;
    affinityMechanismPromptDispose = registerAffinityMechanismPromptInjection({
      ctx,
      config,
      log
    });
  };
  ctx.inject(["chatluna_character"], (innerCtx) => {
    characterCtx = innerCtx;
    reconcileCharacterTools?.();
    if (config.debugLogging) {
      log(
        "info",
        "\u68C0\u6D4B\u5230 chatluna_character \u4F9D\u8D56\u53EF\u7528\uFF0C\u5F00\u59CB\u6302\u8F7D\u6A21\u578B\u54CD\u5E94 runtime"
      );
    }
    modelResponseRuntime.start();
    innerCtx.on("dispose", () => {
      if (config.debugLogging) {
        log("info", "chatluna_character \u4F9D\u8D56\u5DF2\u5378\u8F7D\uFF0C\u505C\u6B62\u6A21\u578B\u54CD\u5E94 runtime");
      }
      replyToolsDispose?.();
      replyToolsDispose = null;
      xmlActionExecutionEnabled = true;
      modelResponseRuntime.stop();
      if (characterCtx === innerCtx) {
        characterCtx = null;
      }
    });
  });
  ctx.on("dispose", () => {
    characterCtx = null;
    replyToolsDispose?.();
    replyToolsDispose = null;
    nativeToolsDispose?.();
    nativeToolsDispose = null;
    referencePromptDispose?.();
    referencePromptDispose = null;
    affinityMechanismPromptDispose?.();
    affinityMechanismPromptDispose = null;
    scopeDispose();
    xmlActionExecutionEnabled = true;
    modelResponseRuntime.stop();
  });
  const fetchMemberBound = (session, userId) => fetchMember(session, userId);
  const resolveUserIdentityBound = (session, input) => resolveUserIdentity(session, input);
  const findMemberByNameBound = (session, name2) => findMemberByName(session, name2, log);
  const fetchGroupMemberIdsBound = (session) => fetchGroupMemberIds(session, log);
  const commandDeps = {
    ctx,
    config,
    log,
    store,
    cache,
    renders,
    fetchMember: fetchMemberBound,
    resolveUserIdentity: resolveUserIdentityBound,
    findMemberByName: findMemberByNameBound,
    fetchGroupMemberIds: fetchGroupMemberIdsBound,
    resolveGroupId,
    stripAtPrefix,
    unblockPermanent
  };
  registerRankCommand(commandDeps);
  registerInspectCommand(commandDeps);
  registerAdjustCommand(commandDeps);
  registerBlacklistCommand({
    ...commandDeps,
    blacklist
  });
  registerBlockCommand({ ...commandDeps, blacklist });
  registerTempBlockCommand({ ...commandDeps, blacklist });
  registerClearAllCommand(commandDeps);
  const initializeServices = async () => {
    log("info", "\u63D2\u4EF6\u521D\u59CB\u5316\u5F00\u59CB...");
    servicesInitialized = true;
    reconcileCharacterTools?.();
    reconcileReferencePrompt?.();
    reconcileAffinityMechanismPrompt?.();
    await migration.run();
    try {
      await manualRelationship.syncToDatabase();
    } catch (error) {
      log("warn", "\u540C\u6B65\u7279\u6B8A\u5173\u7CFB\u914D\u7F6E\u5230\u6570\u636E\u5E93\u5931\u8D25", error);
    }
    const chatlunaService = ctx.chatluna;
    const promptRenderer = chatlunaService?.promptRenderer;
    const plugin = {
      registerTool: (name2, tool) => chatlunaService?.platform?.registerTool?.(name2, tool)
    };
    reconcileNativeTools = () => {
      nativeToolsDispose?.();
      nativeToolsDispose = null;
      if (!isOnlyScope || !isScopeOwner) return;
      if (config.xmlToolSettings.injectXmlToolAsReplyTool) return;
      nativeToolsDispose = registerNativeTools({
        ctx,
        config,
        cache,
        store,
        blacklist,
        unblockPermanent,
        userAlias,
        shortTermConfig,
        actionWindowConfig,
        coefficientConfig,
        plugin,
        log
      });
    };
    reconcileNativeTools();
    const affinityProvider = createAffinityProvider({
      config,
      cache,
      store,
      fetchEntries: history.fetchEntries.bind(history),
      getUserAlias: async (scopeId, platform, userId) => {
        if (scopeId !== config.scopeId) return null;
        return userAlias.getAlias(platform, userId);
      }
    });
    promptRenderer?.registerFunctionProvider?.(
      config.variableSettings.affinityVariableName,
      affinityProvider
    );
    log(
      "info",
      `\u597D\u611F\u5EA6\u53D8\u91CF\u5DF2\u6CE8\u518C: ${config.variableSettings.affinityVariableName}`
    );
    const relationshipLevelName = String(
      config.variableSettings.relationshipLevelVariableName || "relationshipLevel"
    ).trim();
    if (relationshipLevelName) {
      const relationshipLevelProvider = createRelationshipLevelProvider({
        store,
        config
      });
      promptRenderer?.registerFunctionProvider?.(
        relationshipLevelName,
        relationshipLevelProvider
      );
      log("info", `\u597D\u611F\u5EA6\u533A\u95F4\u53D8\u91CF\u5DF2\u6CE8\u518C: ${relationshipLevelName}`);
    }
    const blacklistListName = String(
      config.variableSettings.blacklistListVariableName || "blacklistList"
    ).trim();
    if (blacklistListName) {
      const blacklistListProvider = createBlacklistListProvider({
        scopeId: config.scopeId,
        config,
        store,
        blacklist
      });
      promptRenderer?.registerFunctionProvider?.(
        blacklistListName,
        blacklistListProvider
      );
      log("info", `\u9ED1\u540D\u5355\u5217\u8868\u53D8\u91CF\u5DF2\u6CE8\u518C: ${blacklistListName}`);
    }
    log("info", "\u63D2\u4EF6\u521D\u59CB\u5316\u5B8C\u6210");
  };
  if (ctx.root.lifecycle.isActive) {
    initializeServices().catch((error) => log("warn", "\u63D2\u4EF6\u521D\u59CB\u5316\u5931\u8D25", error));
  } else {
    ctx.on("ready", () => {
      initializeServices().catch(
        (error) => log("warn", "\u63D2\u4EF6\u521D\u59CB\u5316\u5931\u8D25", error)
      );
    });
  }
}

// src/services/relationship/level-resolver.ts
function createLevelResolver(config) {
  const resolveLevelByAffinity = (value) => {
    const levels = config.relationshipAffinityLevels || [];
    for (const level of levels) {
      if (value >= level.min && value <= level.max) return level;
    }
    return null;
  };
  const resolveLevelByRelation = (relationName) => {
    const levels = config.relationshipAffinityLevels || [];
    return levels.find((level) => level.relation === relationName) || null;
  };
  return {
    resolveLevelByAffinity,
    resolveLevelByRelation
  };
}

// src/services/message/store.ts
function createMessageStore(options) {
  const { ctx, log, limit = 100 } = options;
  const cache = /* @__PURE__ */ new Map();
  const makeKey = (session) => {
    if (!session) return "unknown";
    const platform = session.platform || "unknown";
    const selfId = session.selfId || "self";
    const guildId = session?.guildId || "";
    const channelId = session.channelId || session?.roomId || "";
    if (guildId) {
      return `${platform}:${selfId}:${guildId}:${channelId || guildId}`;
    }
    return `${platform}:${selfId}:direct:${channelId || session.userId || "unknown"}`;
  };
  const extractMessageId = (session) => {
    const candidates = [
      session.messageId,
      session?.id,
      session?.event?.message?.id,
      session?.message?.id
    ];
    for (const id of candidates) {
      if (typeof id === "string" && id.trim()) return id.trim();
      if (typeof id === "number") return String(id);
    }
    return "";
  };
  const extractUsername = (session) => {
    const candidates = [
      session.username,
      session?.author?.name,
      session?.author?.nickname,
      session?.event?.user?.name,
      session?.user?.name,
      session.userId
    ];
    for (const name2 of candidates) {
      if (typeof name2 === "string" && name2.trim()) return name2.trim();
    }
    return "\u672A\u77E5\u7528\u6237";
  };
  const record = (session) => {
    if (!session?.platform) return;
    const messageId = extractMessageId(session);
    if (!messageId) return;
    const userId = session.userId || "";
    if (!userId) return;
    const key = makeKey(session);
    const list = cache.get(key) || [];
    const entry = {
      messageId,
      userId,
      username: extractUsername(session),
      content: typeof session.content === "string" ? session.content.slice(0, 200) : "",
      timestamp: new Date(session.timestamp ?? Date.now()).getTime()
    };
    list.push(entry);
    if (list.length > limit) {
      list.splice(0, list.length - limit);
    }
    cache.set(key, list);
    log("debug", "\u5DF2\u8BB0\u5F55\u6D88\u606F", { messageId, userId, key });
  };
  const getMessages = (session, count = 50) => {
    const key = makeKey(session);
    const list = cache.get(key) || [];
    return list.slice(-count);
  };
  const findByLastN = (session, lastN, userId) => {
    const key = makeKey(session);
    const list = cache.get(key) || [];
    if (!list.length) return null;
    let count = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (userId && msg.userId !== userId) continue;
      count++;
      if (count === lastN) {
        return msg;
      }
    }
    return null;
  };
  const findByIds = (session, messageIds) => {
    const key = makeKey(session);
    const list = cache.get(key) || [];
    if (!list.length || !messageIds.length) return [];
    const idSet = new Set(messageIds.map((id) => id.trim()).filter(Boolean));
    return list.filter((msg) => idSet.has(msg.messageId));
  };
  const findByContent = (session, keyword, userId) => {
    const key = makeKey(session);
    const list = cache.get(key) || [];
    if (!list.length || !keyword) return null;
    const lowerKeyword = keyword.toLowerCase();
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (userId && msg.userId !== userId) continue;
      if (msg.content.toLowerCase().includes(lowerKeyword)) {
        return msg;
      }
    }
    return null;
  };
  const clear = (session) => {
    const key = makeKey(session);
    cache.delete(key);
  };
  ctx.on("message", record);
  return {
    record,
    getMessages,
    findByLastN,
    findByIds,
    findByContent,
    clear
  };
}

// src/integrations/onebot/api.ts
function ensureOneBotSession(session) {
  if (!session) return { error: "\u7F3A\u5C11\u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF0C\u65E0\u6CD5\u6267\u884C OneBot \u5DE5\u5177\u3002" };
  if (session.platform !== "onebot") return { error: "\u8BE5\u5DE5\u5177\u4EC5\u652F\u6301 OneBot \u5E73\u53F0\u3002" };
  if (!session.bot) return { error: "\u5F53\u524D\u4F1A\u8BDD\u7F3A\u5C11 bot \u5B9E\u4F8B\uFF0C\u65E0\u6CD5\u6267\u884C\u5DE5\u5177\u3002" };
  const internal = session.bot.internal;
  if (!internal) return { error: "Bot \u9002\u914D\u5668\u672A\u66B4\u9732 OneBot internal \u63A5\u53E3\u3002" };
  return { session, internal };
}
async function callOneBotAPI(internal, action, params, fallbacks = []) {
  if (typeof internal._request === "function") {
    return internal._request(action, params);
  }
  for (const key of fallbacks) {
    if (typeof internal[key] === "function") {
      return internal[key](params);
    }
  }
  throw new Error(`\u5F53\u524D OneBot \u9002\u914D\u5668\u4E0D\u652F\u6301 ${action} \u63A5\u53E3\u3002`);
}

// src/index.ts
var usage = `
## \u4F7F\u7528\u8BF4\u660E

\u9996\u6B21\u4F7F\u7528\u524D\u8BF7\u5148\u9605\u8BFB [readme.md](https://github.com/Sor85/AAAAACAT-chatluna-plugins/blob/main/plugins/chatluna-affinity/readme.md)\uFF0C\u6309\u6587\u6863\u5B8C\u6210\u4F9D\u8D56\u5B89\u88C5\u3001\`scopeId\` \u914D\u7F6E\u3001\u53D8\u91CF\u6CE8\u5165\u548C XML \u5DE5\u5177\u63A5\u5165\u3002

\u6309\u4F60\u7684\u4F7F\u7528\u5165\u53E3\u9009\u62E9\u5BF9\u5E94\u6307\u5357\uFF1A

- \u4F7F\u7528 ChatLuna Character\uFF1A\u67E5\u770B [ChatLuna Character \u63A5\u5165\u6307\u5357](https://github.com/Sor85/AAAAACAT-chatluna-plugins/blob/main/plugins/chatluna-affinity/docs/character-prompt-guide.md)
- \u4F7F\u7528 ChatLuna \u4E3B\u63D2\u4EF6\uFF1A\u67E5\u770B [ChatLuna \u4E3B\u63D2\u4EF6\u63A5\u5165\u6307\u5357](https://github.com/Sor85/AAAAACAT-chatluna-plugins/blob/main/plugins/chatluna-affinity/docs/chatluna-plugin-guide.md)
`;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ACTION_WINDOW_DEFAULTS,
  AFFINITY_DEFAULTS,
  AFFINITY_DYNAMICS_DEFAULTS,
  ALL_MEMBER_INFO_ITEMS,
  AffinitySchema,
  BASE_AFFINITY_DEFAULTS,
  BLACKLIST_MODEL_NAME,
  BLACKLIST_MODEL_NAME_V2,
  BLACKLIST_REPLY_TEMPLATE,
  BlacklistSchema,
  CLOUD_TYPES,
  COEFFICIENT_DEFAULTS,
  COMMON_STYLE,
  Config,
  ConfigSchema,
  DASHBOARD_SNAPSHOT_MODEL_NAME,
  DEFAULT_MEMBER_INFO_ITEMS,
  FETCH_CONSTANTS,
  MIGRATION_MODEL_NAME,
  MODEL_NAME,
  MODEL_NAME_V2,
  NativeToolSettingsSchema,
  OtherSettingsSchema,
  RENDER_CONSTANTS,
  ROLE_MAPPING,
  RelationshipSchema,
  SHORT_TERM_DEFAULTS,
  THRESHOLDS,
  TIME_CONSTANTS,
  TIMING_CONSTANTS,
  USER_AFFINITY_SNAPSHOT_MODEL_NAME,
  USER_ALIAS_MODEL_NAME,
  USER_ALIAS_MODEL_NAME_V2,
  XmlToolSettingsSchema,
  appendActionEntry,
  apply,
  applyAffinityDelta,
  assertScopeId,
  buildAffinityMechanismPrompt,
  buildScopedCommandName,
  callOneBotAPI,
  clamp,
  clampFloat,
  collectNicknameCandidates,
  collectRoleCandidates,
  composeState,
  computeCoefficientValue,
  computeDailyStreak,
  computeShortTermReset,
  createAffinityCache,
  createAffinityProvider,
  createAffinityStore,
  createBlacklistGuard,
  createBlacklistListProvider,
  createBlacklistRenderer,
  createBlacklistService,
  createCharacterTempModelResponseRuntime,
  createInspectRenderer,
  createLevelResolver,
  createLogger,
  createManualRelationshipManager,
  createMessageHistory,
  createMessageStore,
  createMigrationService,
  createModelResponseProcessor,
  createPermanentUnblockHandler,
  createRankListRenderer,
  createRelationshipLevelProvider,
  createRenderService,
  createTableRenderer,
  createUserAliasService,
  dayNumber,
  ensureOneBotSession,
  escapeHtml,
  extendAffinityModel,
  extendBlacklistModel,
  extendDashboardSnapshotModel,
  extendMigrationModel,
  extendUserAliasModel,
  fetchGroupMemberIds,
  fetchMember,
  findMemberByName,
  formatActionCounts,
  formatBeijingTimestamp,
  formatDateOnly,
  formatDateTime,
  formatTimestamp,
  getChannelId,
  getDateString,
  getGuildId,
  getPlatform,
  getRoleDisplay,
  getSelfId,
  getTimeString,
  getUserId,
  hasReplyToolsEnabled,
  inject,
  isFiniteNumber,
  isValidScopeId,
  makeUserKey,
  name,
  normalizeScopeId,
  normalizeTimestamp,
  pickFirst,
  registerActiveScope,
  registerAdjustCommand,
  registerAffinityMechanismPromptInjection,
  registerBlacklistCommand,
  registerBlockCommand,
  registerCharacterPromptInjection,
  registerCharacterReplyTools,
  registerClearAllCommand,
  registerInspectCommand,
  registerModels,
  registerNativeTools,
  registerRankCommand,
  registerTempBlockCommand,
  renderHtml,
  renderInfoField,
  renderMemberInfo,
  renderTemplate,
  resolveActionWindowConfig,
  resolveBotInfo,
  resolveCoefficientConfig,
  resolveGroupId,
  resolveRoleLabel,
  resolveScopedVariableArgs,
  resolveShortTermConfig,
  resolveUserIdentity,
  resolveUserInfo,
  resolveXmlScopeId,
  roundTo,
  sanitizeChannel,
  stripAtPrefix,
  summarizeActionEntries,
  toDate,
  translateGender,
  translateRole,
  truncate,
  usage
});
