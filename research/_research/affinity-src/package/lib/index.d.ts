import * as cosmokit from 'cosmokit';
import { Schema, Session, Context } from 'koishi';
import { CharacterServiceLike as CharacterServiceLike$1, TempLike, CompletionMessagesLike } from 'shared-chatluna-xmltools';

/**
 * 好感度 Schema
 * 定义好感度相关的配置项
 */

declare const AffinitySchema: Schema<Schemastery.ObjectS<{
    affinityEnabled: Schema<boolean, boolean>;
    autoInjectAffinityMechanismPrompt: Schema<boolean, boolean>;
    initialAffinity: Schema<number, number>;
    affinityDynamics: Schema<Schemastery.ObjectS<{
        disableShortTermAffinity: Schema<boolean, boolean>;
        disableAffinityCoefficient: Schema<boolean, boolean>;
        shortTerm: Schema<Schemastery.ObjectS<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>>;
        actionWindow: Schema<Schemastery.ObjectS<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>>;
        coefficient: Schema<Schemastery.ObjectS<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        disableShortTermAffinity: Schema<boolean, boolean>;
        disableAffinityCoefficient: Schema<boolean, boolean>;
        shortTerm: Schema<Schemastery.ObjectS<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>>;
        actionWindow: Schema<Schemastery.ObjectS<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>>;
        coefficient: Schema<Schemastery.ObjectS<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>>;
    }>>;
    rankDefaultLimit: Schema<number, number>;
}>, Schemastery.ObjectT<{
    affinityEnabled: Schema<boolean, boolean>;
    autoInjectAffinityMechanismPrompt: Schema<boolean, boolean>;
    initialAffinity: Schema<number, number>;
    affinityDynamics: Schema<Schemastery.ObjectS<{
        disableShortTermAffinity: Schema<boolean, boolean>;
        disableAffinityCoefficient: Schema<boolean, boolean>;
        shortTerm: Schema<Schemastery.ObjectS<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>>;
        actionWindow: Schema<Schemastery.ObjectS<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>>;
        coefficient: Schema<Schemastery.ObjectS<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        disableShortTermAffinity: Schema<boolean, boolean>;
        disableAffinityCoefficient: Schema<boolean, boolean>;
        shortTerm: Schema<Schemastery.ObjectS<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>>;
        actionWindow: Schema<Schemastery.ObjectS<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>>;
        coefficient: Schema<Schemastery.ObjectS<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>>;
    }>>;
    rankDefaultLimit: Schema<number, number>;
}>>;

/**
 * 黑名单 Schema
 * 定义黑名单相关的配置项
 */

declare const BlacklistSchema: Schema<Schemastery.ObjectS<{
    blacklistLogInterception: Schema<boolean, boolean>;
    shortTermBlacklistPenalty: Schema<number, number>;
    unblockPermanentInitialAffinity: Schema<number, number>;
    blacklistDefaultLimit: Schema<number, number>;
}>, Schemastery.ObjectT<{
    blacklistLogInterception: Schema<boolean, boolean>;
    shortTermBlacklistPenalty: Schema<number, number>;
    unblockPermanentInitialAffinity: Schema<number, number>;
    blacklistDefaultLimit: Schema<number, number>;
}>>;

declare const RelationshipSchema: Schema<Schemastery.ObjectS<{
    relationships: Schema<({
        userId?: string | null | undefined;
        relation?: string | null | undefined;
        note?: string | null | undefined;
    } & cosmokit.Dict)[], Schemastery.ObjectT<{
        userId: Schema<string, string>;
        relation: Schema<string, string>;
        note: Schema<string, string>;
    }>[]>;
    relationshipAffinityLevels: Schema<({
        min?: number | null | undefined;
        max?: number | null | undefined;
        relation?: string | null | undefined;
        note?: string | null | undefined;
    } & cosmokit.Dict)[], Schemastery.ObjectT<{
        min: Schema<number, number>;
        max: Schema<number, number>;
        relation: Schema<string, string>;
        note: Schema<string, string>;
    }>[]>;
}>, Schemastery.ObjectT<{
    relationships: Schema<({
        userId?: string | null | undefined;
        relation?: string | null | undefined;
        note?: string | null | undefined;
    } & cosmokit.Dict)[], Schemastery.ObjectT<{
        userId: Schema<string, string>;
        relation: Schema<string, string>;
        note: Schema<string, string>;
    }>[]>;
    relationshipAffinityLevels: Schema<({
        min?: number | null | undefined;
        max?: number | null | undefined;
        relation?: string | null | undefined;
        note?: string | null | undefined;
    } & cosmokit.Dict)[], Schemastery.ObjectT<{
        min: Schema<number, number>;
        max: Schema<number, number>;
        relation: Schema<string, string>;
        note: Schema<string, string>;
    }>[]>;
}>>;

/**
 * 工具与变量设置 Schema
 * 定义 scopeId、XML 工具与变量名称配置
 */

declare const NativeToolSettingsSchema: Schema<Schemastery.ObjectS<{
    nativeToolSettings: Schema<Schemastery.ObjectS<{
        enabledNativeTools: Schema<("affinity" | "blacklist" | "relationship" | "userAlias")[], ("affinity" | "blacklist" | "relationship" | "userAlias")[]>;
        affinity: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        blacklist: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        relationship: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        userAlias: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
    }>, Schemastery.ObjectT<{
        enabledNativeTools: Schema<("affinity" | "blacklist" | "relationship" | "userAlias")[], ("affinity" | "blacklist" | "relationship" | "userAlias")[]>;
        affinity: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        blacklist: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        relationship: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        userAlias: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
    }>>;
}>, Schemastery.ObjectT<{
    nativeToolSettings: Schema<Schemastery.ObjectS<{
        enabledNativeTools: Schema<("affinity" | "blacklist" | "relationship" | "userAlias")[], ("affinity" | "blacklist" | "relationship" | "userAlias")[]>;
        affinity: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        blacklist: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        relationship: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        userAlias: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
    }>, Schemastery.ObjectT<{
        enabledNativeTools: Schema<("affinity" | "blacklist" | "relationship" | "userAlias")[], ("affinity" | "blacklist" | "relationship" | "userAlias")[]>;
        affinity: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        blacklist: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        relationship: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        userAlias: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
    }>>;
}>>;
declare const XmlToolSettingsSchema: Schema<Schemastery.ObjectS<{
    injectXmlToolAsReplyTool: Schema<boolean, boolean>;
    enableAffinityXmlToolCall: Schema<boolean, boolean>;
    enableBlacklistXmlToolCall: Schema<boolean, boolean>;
    enableRelationshipXmlToolCall: Schema<boolean, boolean>;
    enableUserAliasXmlToolCall: Schema<boolean, boolean>;
    autoInjectReferencePrompt: Schema<boolean, boolean>;
    characterPromptTemplate: Schema<string, string>;
}>, Schemastery.ObjectT<{
    injectXmlToolAsReplyTool: Schema<boolean, boolean>;
    enableAffinityXmlToolCall: Schema<boolean, boolean>;
    enableBlacklistXmlToolCall: Schema<boolean, boolean>;
    enableRelationshipXmlToolCall: Schema<boolean, boolean>;
    enableUserAliasXmlToolCall: Schema<boolean, boolean>;
    autoInjectReferencePrompt: Schema<boolean, boolean>;
    characterPromptTemplate: Schema<string, string>;
}>>;
declare const OtherSettingsSchema: Schema<Schemastery.ObjectS<{
    enableDashboard: Schema<boolean, boolean>;
    rankRenderAsImage: Schema<boolean, boolean>;
    blacklistRenderAsImage: Schema<boolean, boolean>;
    shortTermBlacklistRenderAsImage: Schema<boolean, boolean>;
    inspectRenderAsImage: Schema<boolean, boolean>;
    inspectShowImpression: Schema<boolean, boolean>;
    debugLogging: Schema<boolean, boolean>;
}>, Schemastery.ObjectT<{
    enableDashboard: Schema<boolean, boolean>;
    rankRenderAsImage: Schema<boolean, boolean>;
    blacklistRenderAsImage: Schema<boolean, boolean>;
    shortTermBlacklistRenderAsImage: Schema<boolean, boolean>;
    inspectRenderAsImage: Schema<boolean, boolean>;
    inspectShowImpression: Schema<boolean, boolean>;
    debugLogging: Schema<boolean, boolean>;
}>>;

declare const name = "chatluna-affinity";
declare const inject: {
    required: string[];
    optional: string[];
};
declare const ConfigSchema: Schema<{
    affinityEnabled?: boolean | null | undefined;
    autoInjectAffinityMechanismPrompt?: boolean | null | undefined;
    initialAffinity?: number | null | undefined;
    affinityDynamics?: ({
        disableShortTermAffinity?: boolean | null | undefined;
        disableAffinityCoefficient?: boolean | null | undefined;
        shortTerm?: ({
            promoteThreshold?: number | null | undefined;
            demoteThreshold?: number | null | undefined;
            longTermPromoteStep?: number | null | undefined;
            longTermDemoteStep?: number | null | undefined;
        } & cosmokit.Dict) | null | undefined;
        actionWindow?: ({
            windowHours?: number | null | undefined;
            increaseBonus?: number | null | undefined;
            decreaseBonus?: number | null | undefined;
            bonusChatThreshold?: number | null | undefined;
            maxEntries?: number | null | undefined;
        } & cosmokit.Dict) | null | undefined;
        coefficient?: ({
            base?: number | null | undefined;
            maxDrop?: number | null | undefined;
            maxBoost?: number | null | undefined;
            decayPerDay?: number | null | undefined;
            boostPerDay?: number | null | undefined;
        } & cosmokit.Dict) | null | undefined;
    } & cosmokit.Dict) | null | undefined;
    rankDefaultLimit?: number | null | undefined;
} & cosmokit.Dict & {
    blacklistLogInterception?: boolean | null | undefined;
    shortTermBlacklistPenalty?: number | null | undefined;
    unblockPermanentInitialAffinity?: number | null | undefined;
    blacklistDefaultLimit?: number | null | undefined;
} & {
    relationships?: ({
        userId?: string | null | undefined;
        relation?: string | null | undefined;
        note?: string | null | undefined;
    } & cosmokit.Dict)[] | null | undefined;
    relationshipAffinityLevels?: ({
        min?: number | null | undefined;
        max?: number | null | undefined;
        relation?: string | null | undefined;
        note?: string | null | undefined;
    } & cosmokit.Dict)[] | null | undefined;
} & {
    scopeId?: string | null | undefined;
    botSelfIds?: string[] | null | undefined;
} & {
    nativeToolSettings?: ({
        enabledNativeTools?: ("affinity" | "blacklist" | "relationship" | "userAlias")[] | null | undefined;
        affinity?: ({
            toolName?: string | null | undefined;
            description?: string | null | undefined;
        } & cosmokit.Dict) | null | undefined;
        blacklist?: ({
            toolName?: string | null | undefined;
            description?: string | null | undefined;
        } & cosmokit.Dict) | null | undefined;
        relationship?: ({
            toolName?: string | null | undefined;
            description?: string | null | undefined;
        } & cosmokit.Dict) | null | undefined;
        userAlias?: ({
            toolName?: string | null | undefined;
            description?: string | null | undefined;
        } & cosmokit.Dict) | null | undefined;
    } & cosmokit.Dict) | null | undefined;
} & {
    injectXmlToolAsReplyTool?: boolean | null | undefined;
    enableAffinityXmlToolCall?: boolean | null | undefined;
    enableBlacklistXmlToolCall?: boolean | null | undefined;
    enableRelationshipXmlToolCall?: boolean | null | undefined;
    enableUserAliasXmlToolCall?: boolean | null | undefined;
    autoInjectReferencePrompt?: boolean | null | undefined;
    characterPromptTemplate?: string | null | undefined;
} & {
    affinityVariableName?: string | null | undefined;
    showChatCountInAffinityVariable?: boolean | null | undefined;
    affinityDisplayRange?: number | null | undefined;
    relationshipLevelVariableName?: string | null | undefined;
    blacklistListVariableName?: string | null | undefined;
} & {
    enableDashboard?: boolean | null | undefined;
    rankRenderAsImage?: boolean | null | undefined;
    blacklistRenderAsImage?: boolean | null | undefined;
    shortTermBlacklistRenderAsImage?: boolean | null | undefined;
    inspectRenderAsImage?: boolean | null | undefined;
    inspectShowImpression?: boolean | null | undefined;
    debugLogging?: boolean | null | undefined;
}, {
    affinityEnabled: boolean;
    autoInjectAffinityMechanismPrompt: boolean;
    initialAffinity: number;
    affinityDynamics: Schemastery.ObjectT<{
        disableShortTermAffinity: Schema<boolean, boolean>;
        disableAffinityCoefficient: Schema<boolean, boolean>;
        shortTerm: Schema<Schemastery.ObjectS<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            promoteThreshold: Schema<number, number>;
            demoteThreshold: Schema<number, number>;
            longTermPromoteStep: Schema<number, number>;
            longTermDemoteStep: Schema<number, number>;
        }>>;
        actionWindow: Schema<Schemastery.ObjectS<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            windowHours: Schema<number, number>;
            increaseBonus: Schema<number, number>;
            decreaseBonus: Schema<number, number>;
            bonusChatThreshold: Schema<number, number>;
            maxEntries: Schema<number, number>;
        }>>;
        coefficient: Schema<Schemastery.ObjectS<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            base: Schema<number, number>;
            maxDrop: Schema<number, number>;
            maxBoost: Schema<number, number>;
            decayPerDay: Schema<number, number>;
            boostPerDay: Schema<number, number>;
        }>>;
    }>;
    rankDefaultLimit: number;
} & cosmokit.Dict & {
    blacklistLogInterception: boolean;
    shortTermBlacklistPenalty: number;
    unblockPermanentInitialAffinity: number;
    blacklistDefaultLimit: number;
} & {
    relationships: Schemastery.ObjectT<{
        userId: Schema<string, string>;
        relation: Schema<string, string>;
        note: Schema<string, string>;
    }>[];
    relationshipAffinityLevels: Schemastery.ObjectT<{
        min: Schema<number, number>;
        max: Schema<number, number>;
        relation: Schema<string, string>;
        note: Schema<string, string>;
    }>[];
} & {
    scopeId: string;
    botSelfIds: string[];
} & {
    nativeToolSettings: Schemastery.ObjectT<{
        enabledNativeTools: Schema<("affinity" | "blacklist" | "relationship" | "userAlias")[], ("affinity" | "blacklist" | "relationship" | "userAlias")[]>;
        affinity: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        blacklist: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        relationship: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
        userAlias: Schema<Schemastery.ObjectS<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>, Schemastery.ObjectT<{
            toolName: Schema<string, string>;
            description: Schema<string, string>;
        }>>;
    }>;
} & {
    injectXmlToolAsReplyTool: boolean;
    enableAffinityXmlToolCall: boolean;
    enableBlacklistXmlToolCall: boolean;
    enableRelationshipXmlToolCall: boolean;
    enableUserAliasXmlToolCall: boolean;
    autoInjectReferencePrompt: boolean;
    characterPromptTemplate: string;
} & {
    affinityVariableName: string;
    showChatCountInAffinityVariable: boolean;
    affinityDisplayRange: number;
    relationshipLevelVariableName: string;
    blacklistListVariableName: string;
} & {
    enableDashboard: boolean;
    rankRenderAsImage: boolean;
    blacklistRenderAsImage: boolean;
    shortTermBlacklistRenderAsImage: boolean;
    inspectRenderAsImage: boolean;
    inspectShowImpression: boolean;
    debugLogging: boolean;
}>;

/**
 * 通用类型定义
 * 包含日志、数值处理、会话种子等基础类型
 */

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFn = (level: LogLevel, message: string, detail?: unknown) => void;
type ClampFn = (value: number, low: number, high: number) => number;
interface SessionSeed {
    scopeId?: string;
    platform?: string;
    userId?: string;
    nickname?: string;
    authorNickname?: string;
    session?: Session;
}

/**
 * 好感度相关类型定义
 * 包含好感度记录、状态、动作、系数等核心类型
 */
interface LegacyAffinityRecord {
    userId: string;
    nickname: string | null;
    affinity: number;
    relation: string | null;
    specialRelation: string | null;
    shortTermAffinity: number | null;
    longTermAffinity: number | null;
    chatCount: number | null;
    actionStats: string | null;
    lastInteractionAt: Date | null;
    coefficientState: string | null;
}
interface AffinityRecord extends LegacyAffinityRecord {
    scopeId: string;
}
type ActionType = "increase" | "decrease";
interface ActionEntry {
    action: ActionType;
    timestamp: number;
}
interface ActionCounts {
    increase: number;
    decrease: number;
}
interface ActionStats {
    total: number;
    counts: ActionCounts;
    entries: ActionEntry[];
}
interface CoefficientState {
    streak: number;
    coefficient: number;
    decayPenalty: number;
    streakBoost: number;
    inactivityDays: number;
    lastInteractionAt: Date | null;
}
interface AffinityState {
    affinity: number;
    longTermAffinity: number;
    shortTermAffinity: number;
    chatCount: number;
    actionStats: ActionStats;
    lastInteractionAt: Date | null;
    coefficientState: CoefficientState;
    isNew?: boolean;
}
interface CombinedState {
    affinity: number;
    longTermAffinity: number;
    shortTermAffinity: number;
}
interface InitialRange {
    low: number;
    high: number;
    min: number;
    max: number;
}
interface SaveExtra {
    longTermAffinity?: number;
    shortTermAffinity?: number;
    chatCount?: number;
    actionStats?: ActionStats;
    coefficientState?: CoefficientState;
    lastInteractionAt?: Date;
}
interface ResolvedShortTermConfig {
    disableShortTermAffinity: boolean;
    promoteThreshold: number;
    demoteThreshold: number;
    longTermPromoteStep: number;
    longTermDemoteStep: number;
}
interface ResolvedActionWindowConfig {
    windowHours: number;
    windowMs: number;
    increaseBonus: number;
    decreaseBonus: number;
    bonusChatThreshold: number;
    maxEntries: number;
}
interface ResolvedCoefficientConfig {
    disableAffinityCoefficient: boolean;
    base: number;
    maxDrop: number;
    maxBoost: number;
    decayPerDay: number;
    boostPerDay: number;
    min: number;
    max: number;
}
interface CoefficientResult {
    coefficient: number;
    decayPenalty: number;
    streakBoost: number;
    inactivityDays: number;
}
interface SummarizedActions {
    entries: ActionEntry[];
    counts: ActionCounts;
    total: number;
}
interface AffinityCache {
    get: (scopeId: string, userId: string) => number | null;
    set: (scopeId: string, userId: string, value: number) => void;
    clear: (scopeId: string, userId: string) => void;
    clearAll?: () => void;
}

/**
 * 黑名单相关类型定义
 * 包含数据库记录、展示结构和服务接口
 */
type BlacklistMode = "permanent" | "temporary";
interface LegacyBlacklistRecord {
    platform: string;
    userId: string;
    mode: BlacklistMode;
    blockedAt: Date;
    expiresAt: Date | null;
    nickname: string | null;
    note: string | null;
    durationHours: number | null;
    penalty: number | null;
}
interface BlacklistRecord extends LegacyBlacklistRecord {
    scopeId: string;
}
interface BlacklistEntry {
    scopeId: string;
    platform: string;
    userId: string;
    blockedAt: string;
    nickname?: string;
    note: string;
}
interface TemporaryBlacklistEntry {
    scopeId: string;
    platform: string;
    userId: string;
    blockedAt: string;
    expiresAt: string;
    nickname?: string;
    note: string;
    durationHours: number | string;
    penalty: number | string;
}
interface BlacklistDetail {
    note?: string;
    nickname?: string;
}
interface InMemoryTemporaryEntry {
    expiresAt: number;
    nickname: string;
}

/**
 * 仪表盘快照类型
 */
interface DashboardSnapshotRecord {
    scopeId: string;
    date: string;
    recordedAt: Date;
    generatedBy: string | null;
    users: number;
    affinityTotal: number;
    longTermAffinityTotal: number;
    shortTermAffinityTotal: number;
    chatCount: number;
    blacklisted: number;
    permanentBlacklisted: number;
    temporaryBlacklisted: number;
    aliases: number;
    latestInteractionAt: Date | null;
}
interface UserAffinitySnapshotRecord {
    scopeId: string;
    userId: string;
    date: string;
    recordedAt: Date;
    nickname: string | null;
    affinity: number;
    longTermAffinity: number;
    shortTermAffinity: number;
    chatCount: number;
    relation: string | null;
    specialRelation: string | null;
    lastInteractionAt: Date | null;
}

/**
 * 成员信息相关类型定义
 * 包含群成员信息、角色映射、群信息等类型
 */

type MemberInfoField = "nickname" | "userId" | "role" | "level" | "title" | "gender" | "age" | "area" | "joinTime" | "lastSentTime" | "chatCount";
interface MemberInfo {
    card?: string;
    remark?: string;
    displayName?: string;
    nick?: string;
    nickname?: string;
    name?: string;
    user?: {
        nickname?: string;
        name?: string;
    };
    level?: string | number;
    levelName?: string;
    level_name?: string;
    level_info?: {
        current_level?: string | number;
        level?: string | number;
    };
    title?: string;
    specialTitle?: string;
    special_title?: string;
    sex?: string;
    gender?: string;
    age?: number;
    area?: string;
    region?: string;
    location?: string;
    join_time?: number | string;
    joined_at?: number | string;
    joinTime?: number | string;
    joinedAt?: number | string;
    joinTimestamp?: number | string;
    last_sent_time?: number | string;
    lastSentTime?: number | string;
    lastSpeakTimestamp?: number | string;
    role?: string;
    roleName?: string;
    permission?: string;
    permissions?: string | string[];
    identity?: string;
    type?: string;
    status?: string;
    roles?: string[];
    userId?: string;
    id?: string;
    qq?: string;
    uid?: string;
    user_id?: string;
}
interface RenderMemberInfoOptions {
    fallbackNames?: string[];
    defaultItems?: MemberInfoField[];
    logUnknown?: boolean;
    log?: LogFn;
    chatCount?: number;
}
interface RoleTranslation {
    role: string;
    matched: boolean;
    raw: unknown;
}
interface RoleMapping {
    direct: Record<string, string>;
    keywords: Record<string, string[]>;
    numeric: Record<string, string>;
}

/**
 * 用户自定义昵称类型定义
 * 包含数据库记录与变量输出结构
 */
interface LegacyUserAliasRecord {
    platform: string;
    userId: string;
    alias: string;
    updatedAt: Date;
}
interface UserAliasRecord extends LegacyUserAliasRecord {
    scopeId: string;
}

/**
 * 配置相关类型定义
 * 包含插件配置及各子模块配置类型
 */
interface ShortTermConfig {
    promoteThreshold: number;
    demoteThreshold: number;
    longTermPromoteStep: number;
    longTermDemoteStep: number;
    longTermStep?: number;
    resetBiasRange?: number;
}
interface ActionWindowConfig {
    windowHours: number;
    increaseBonus: number;
    decreaseBonus: number;
    bonusChatThreshold: number;
    maxEntries: number;
}
interface CoefficientConfig {
    base: number;
    maxDrop: number;
    maxBoost: number;
    decayPerDay: number;
    boostPerDay: number;
}
interface AffinityDynamicsConfig {
    disableShortTermAffinity?: boolean;
    disableAffinityCoefficient?: boolean;
    shortTerm?: Partial<ShortTermConfig>;
    actionWindow?: Partial<ActionWindowConfig>;
    coefficient?: Partial<CoefficientConfig>;
}
interface RelationshipLevel {
    min: number;
    max: number;
    relation: string;
    note?: string;
}
interface ManualRelationship {
    userId: string;
    relation: string;
    note?: string;
}
interface VariableSettings {
    affinityVariableName: string;
    showChatCountInAffinityVariable: boolean;
    relationshipLevelVariableName: string;
    blacklistListVariableName: string;
}
interface XmlToolSettings {
    injectXmlToolAsReplyTool: boolean;
    enableAffinityXmlToolCall: boolean;
    enableBlacklistXmlToolCall: boolean;
    enableRelationshipXmlToolCall: boolean;
    enableUserAliasXmlToolCall: boolean;
    autoInjectReferencePrompt: boolean;
    characterPromptTemplate: string;
}
type NativeToolKey = "affinity" | "blacklist" | "relationship" | "userAlias";
interface NativeToolItemConfig {
    toolName: string;
    description: string;
}
interface NativeToolSettings {
    enabledNativeTools?: NativeToolKey[];
    affinity: NativeToolItemConfig;
    blacklist: NativeToolItemConfig;
    relationship: NativeToolItemConfig;
    userAlias: NativeToolItemConfig;
}
interface Config {
    scopeId: string;
    botSelfIds: string[];
    affinityEnabled: boolean;
    autoInjectAffinityMechanismPrompt: boolean;
    affinityDisplayRange: number;
    initialAffinity: number;
    affinityDynamics?: AffinityDynamicsConfig;
    blacklistLogInterception: boolean;
    shortTermBlacklistPenalty: number;
    unblockPermanentInitialAffinity: number;
    rankDefaultLimit: number;
    rankRenderAsImage: boolean;
    blacklistDefaultLimit: number;
    inspectRenderAsImage: boolean;
    inspectShowImpression: boolean;
    enableDashboard: boolean;
    debugLogging: boolean;
    blacklistRenderAsImage: boolean;
    shortTermBlacklistRenderAsImage: boolean;
    relationships: ManualRelationship[];
    relationshipAffinityLevels: RelationshipLevel[];
    variableSettings: VariableSettings;
    nativeToolSettings: NativeToolSettings;
    xmlToolSettings: XmlToolSettings;
}

/**
 * 插件主逻辑
 * 组装所有模块并初始化插件功能
 */

declare function apply(ctx: Context, config: Config): void;

/**
 * 默认值常量
 * 包含好感度、时间、阈值等默认配置
 */
declare const AFFINITY_DEFAULTS: {
    readonly MIN: 0;
    readonly MAX: 100;
    readonly INITIAL_MIN: 20;
    readonly INITIAL_MAX: 40;
};
declare const SHORT_TERM_DEFAULTS: {
    readonly PROMOTE_THRESHOLD: 15;
    readonly DEMOTE_THRESHOLD: -15;
    readonly LONG_TERM_STEP: 3;
};
declare const ACTION_WINDOW_DEFAULTS: {
    readonly WINDOW_HOURS: 24;
    readonly INCREASE_BONUS: 2;
    readonly DECREASE_BONUS: 2;
    readonly BONUS_CHAT_THRESHOLD: 0;
    readonly MAX_ENTRIES: 60;
};
declare const COEFFICIENT_DEFAULTS: {
    readonly BASE: 1;
    readonly MAX_DROP: 0.3;
    readonly MAX_BOOST: 0.3;
    readonly DECAY_PER_DAY_RATIO: 3;
    readonly BOOST_PER_DAY_RATIO: 3;
    readonly FALLBACK_DECAY: 0.1;
    readonly FALLBACK_BOOST: 0.1;
};
declare const TIME_CONSTANTS: {
    readonly MS_PER_SECOND: 1000;
    readonly MS_PER_MINUTE: number;
    readonly MS_PER_HOUR: number;
    readonly MS_PER_DAY: number;
    readonly SECONDS_THRESHOLD: 100000000000;
};
declare const THRESHOLDS: {
    readonly BLACKLIST_DEFAULT: -50;
    readonly MIN_ENTRIES: 10;
    readonly MIN_WINDOW_HOURS: 1;
    readonly UNBLOCK_PERMANENT_INITIAL_AFFINITY: 10;
};
declare const RENDER_CONSTANTS: {
    readonly VIEWPORT_WIDTH: 800;
    readonly VIEWPORT_BASE_HEIGHT: 220;
    readonly VIEWPORT_ROW_HEIGHT: 48;
};
declare const TIMING_CONSTANTS: {
    readonly ANALYSIS_TIMEOUT: 30000;
    readonly BOT_REPLY_DELAY: 3000;
    readonly SCHEDULE_RETRY_DELAY: 2000;
    readonly SCHEDULE_CHECK_INTERVAL: 60000;
};
declare const FETCH_CONSTANTS: {
    readonly HISTORY_LIMIT_MULTIPLIER: 6;
    readonly MIN_HISTORY_LIMIT: 60;
    readonly RANK_FETCH_MULTIPLIER: 5;
    readonly RANK_FETCH_OFFSET: 20;
    readonly MAX_RANK_FETCH: 200;
};
declare const BASE_AFFINITY_DEFAULTS: {
    readonly initialAffinity: 30;
};
declare const AFFINITY_DYNAMICS_DEFAULTS: {
    readonly shortTerm: {
        readonly promoteThreshold: 15;
        readonly demoteThreshold: -10;
        readonly longTermPromoteStep: 3;
        readonly longTermDemoteStep: 5;
    };
    readonly actionWindow: {
        readonly windowHours: 24;
        readonly increaseBonus: 2;
        readonly decreaseBonus: 2;
        readonly bonusChatThreshold: 10;
        readonly maxEntries: 80;
    };
    readonly coefficient: {
        readonly base: 1;
        readonly maxDrop: 0.3;
        readonly maxBoost: 0.3;
        readonly decayPerDay: 0.05;
        readonly boostPerDay: 0.05;
    };
};

/**
 * 提示词模板常量
 * 包含自动拉黑回复模板
 */
declare const BLACKLIST_REPLY_TEMPLATE = "";

/**
 * 映射表常量
 * 包含角色映射、网盘类型等静态映射数据
 */

declare const ROLE_MAPPING: RoleMapping;
declare const CLOUD_TYPES: Record<string, string>;
declare const DEFAULT_MEMBER_INFO_ITEMS: readonly ["nickname", "userId", "role", "level", "title"];
declare const ALL_MEMBER_INFO_ITEMS: readonly ["nickname", "userId", "role", "level", "title", "gender", "age", "area", "joinTime", "lastSentTime", "chatCount"];

/**
 * 数学工具函数
 * 包含数值范围限制等函数
 */
declare function clamp(value: number, min: number, max: number): number;
declare function clampFloat(value: number, min: number, max: number): number;
declare function isFiniteNumber(value: unknown): value is number;
declare function roundTo(value: number, decimals: number): number;

/**
 * 时间工具函数
 * 包含时间格式化、时间戳处理等函数
 */
declare function normalizeTimestamp(value: unknown): number | null;
declare function formatTimestamp(value: unknown): string;
declare function formatBeijingTimestamp(date: Date): string;
declare function formatDateOnly(value: unknown): string;
declare function formatDateTime(value: unknown): string;
declare function toDate(value: unknown): Date | null;
declare function dayNumber(date: Date): number;
declare function getDateString(date: Date, timezone?: string): string;
declare function getTimeString(date: Date, timezone?: string): string;

/**
 * 字符串工具函数
 * 包含前缀处理、清理等函数
 */
declare function stripAtPrefix(text: string | unknown): string;
declare function sanitizeChannel(value: unknown): string;
declare function pickFirst<T>(...values: (T | undefined | null)[]): T | undefined;
declare function truncate(text: string, maxLength: number, suffix?: string): string;
declare function escapeHtml(text: string): string;

/**
 * 模板工具函数
 * 包含简单模板字符串渲染
 */
declare function renderTemplate(template: string, vars: Record<string, string | number>): string;

/**
 * 日志工具
 * 提供统一的日志记录接口，支持按配置开关调试日志
 */

interface LoggerConfig {
    debugLogging?: boolean;
}
declare function createLogger(ctx: Context, config: LoggerConfig): LogFn;

/**
 * Session 辅助函数
 * 提供从 Koishi Session 对象中安全提取常用信息的工具
 */

interface SessionLike$1 {
    channelId?: string;
    guildId?: string;
    groupId?: string;
    roomId?: string;
    platform?: string;
    userId?: string;
    selfId?: string;
    event?: {
        channel?: {
            id?: string;
        };
        guild?: {
            id?: string;
        };
        group?: {
            id?: string;
        };
        platform?: string;
        user?: {
            id?: string;
        };
        selfId?: string;
    };
    bot?: {
        platform?: string;
        selfId?: string;
    };
}
declare function getChannelId(session: Session | SessionLike$1 | null | undefined): string;
declare function getGuildId(session: Session | SessionLike$1 | null | undefined): string;
declare function getPlatform(session: Session | SessionLike$1 | null | undefined): string;
declare function getUserId(session: Session | SessionLike$1 | null | undefined): string;
declare function getSelfId(session: Session | SessionLike$1 | null | undefined): string;
declare function makeUserKey(platform: string, userId: string): string;

/**
 * scopeId 辅助函数
 * 提供 scopeId 校验、命令名拼接与变量参数解析
 */
declare function normalizeScopeId(value: unknown): string;
declare function isValidScopeId(value: string): boolean;
declare function assertScopeId(value: unknown): string;
declare function buildScopedCommandName(scopeId: string, suffix: string): string;
declare function resolveScopedVariableArgs(args: unknown[] | undefined): {
    scopeId: string;
    targetUserId: string;
} | null;

/**
 * 角色映射工具
 * 将各种平台的角色标识转换为统一的中文角色名称
 */

declare function translateRole(value: unknown): RoleTranslation;
interface WithRole {
    role?: unknown;
    roleName?: unknown;
    permission?: unknown;
    permissions?: unknown;
    title?: unknown;
    identity?: unknown;
    type?: unknown;
    level?: unknown;
    status?: unknown;
    roles?: unknown;
    member?: unknown;
    author?: unknown;
    event?: {
        member?: unknown;
        sender?: unknown;
        operator?: unknown;
        self?: unknown;
        bot?: unknown;
    };
    payload?: {
        sender?: unknown;
    };
    user?: unknown;
    self?: unknown;
    bot?: {
        user?: unknown;
    };
}
declare function collectRoleCandidates(session: WithRole | null | undefined, member: unknown): unknown[];
interface ResolveRoleLabelOptions {
    logUnknown?: boolean;
    logger?: LogFn;
}
declare function resolveRoleLabel(session: Session | null | undefined, member: unknown, options?: ResolveRoleLabelOptions): string;
declare function getRoleDisplay(role: string): string;

/**
 * 成员信息辅助函数
 * 提供群成员信息获取、解析和渲染功能
 */

declare function translateGender(value: unknown): string;
declare function collectNicknameCandidates(member: MemberInfo | null | undefined, userId: string, fallbackNames?: string[]): string[];
interface RenderFieldOptions {
    userId: string;
    fallbackNames?: string[];
    logUnknown?: boolean;
    log?: LogFn;
    chatCount?: number;
}
declare function renderInfoField(fieldName: MemberInfoField, member: MemberInfo | null | undefined, session: Session | null | undefined, options: RenderFieldOptions): string | null;
declare function renderMemberInfo(session: Session | null | undefined, member: MemberInfo | null | undefined, userId: string, configItems: string[] | undefined, options?: RenderMemberInfoOptions): string;
type FetchMemberFn = (session: Session, userId: string) => Promise<MemberInfo | null>;
declare function resolveUserInfo(session: Session, configItems: string[] | undefined, fetchMemberFn: FetchMemberFn, options?: RenderMemberInfoOptions): Promise<string>;
declare function resolveBotInfo(session: Session, configItems: string[] | undefined, fetchMemberFn: FetchMemberFn, options?: RenderMemberInfoOptions): Promise<string>;
declare function fetchMember(session: Session, userId: string): Promise<MemberInfo | null>;
declare function resolveUserIdentity(session: Session, input: string): Promise<{
    userId: string;
    nickname: string;
} | null>;
declare function findMemberByName(session: Session, name: string, log?: LogFn): Promise<{
    userId: string;
    nickname: string;
} | null>;
declare function resolveGroupId(session: Session): string;
declare function fetchGroupMemberIds(session: Session, log?: LogFn): Promise<Set<string> | null>;

/**
 * 好感度数据表定义
 * 定义 chatluna_affinity 表结构及类型声明
 */

declare const MODEL_NAME = "chatluna_affinity";
declare const MODEL_NAME_V2 = "chatluna_affinity_v2";
declare module "koishi" {
    interface Tables {
        [MODEL_NAME]: LegacyAffinityRecord;
        [MODEL_NAME_V2]: AffinityRecord;
    }
}
declare function extendAffinityModel(ctx: Context): void;

/**
 * 黑名单数据表定义
 * 定义 chatluna_blacklist 表结构及类型声明
 */

declare const BLACKLIST_MODEL_NAME = "chatluna_blacklist";
declare const BLACKLIST_MODEL_NAME_V2 = "chatluna_blacklist_v2";
declare module "koishi" {
    interface Tables {
        [BLACKLIST_MODEL_NAME]: LegacyBlacklistRecord;
        [BLACKLIST_MODEL_NAME_V2]: BlacklistRecord;
    }
}
declare function extendBlacklistModel(ctx: Context): void;

/**
 * 用户自定义昵称数据表定义
 * 定义 chatluna_user_alias 表结构及类型声明
 */

declare const USER_ALIAS_MODEL_NAME = "chatluna_user_alias";
declare const USER_ALIAS_MODEL_NAME_V2 = "chatluna_user_alias_v2";
declare module "koishi" {
    interface Tables {
        [USER_ALIAS_MODEL_NAME]: LegacyUserAliasRecord;
        [USER_ALIAS_MODEL_NAME_V2]: UserAliasRecord;
    }
}
declare function extendUserAliasModel(ctx: Context): void;

/**
 * 迁移记录表定义
 * 记录 scopeId 级别迁移状态与版本
 */

declare const MIGRATION_MODEL_NAME = "chatluna_affinity_migrations";
interface MigrationRecord {
    scopeId: string;
    version: string;
    migratedAt: Date;
    status: "success" | "failed" | "skipped";
}
declare module "koishi" {
    interface Tables {
        [MIGRATION_MODEL_NAME]: MigrationRecord;
    }
}
declare function extendMigrationModel(ctx: Context): void;

/**
 * 仪表盘日级快照表定义
 */

declare const DASHBOARD_SNAPSHOT_MODEL_NAME = "chatluna_affinity_dashboard_snapshot";
declare const USER_AFFINITY_SNAPSHOT_MODEL_NAME = "chatluna_affinity_user_snapshot";
declare module "koishi" {
    interface Tables {
        [DASHBOARD_SNAPSHOT_MODEL_NAME]: DashboardSnapshotRecord;
        [USER_AFFINITY_SNAPSHOT_MODEL_NAME]: UserAffinitySnapshotRecord;
    }
}
declare function extendDashboardSnapshotModel(ctx: Context): void;

/**
 * 数据模型统一导出
 * 提供数据库模型注册入口
 */

declare function registerModels(ctx: Context): void;

/**
 * 好感度缓存
 * 提供简单的单条目缓存，用于快速读取最近访问的好感度值
 */

declare function createAffinityCache(): AffinityCache;

/**
 * 好感度计算器
 * 提供短期/长期好感度、动作窗口、系数等配置解析和计算函数
 */

declare function resolveShortTermConfig(config: Config): ResolvedShortTermConfig;
declare function resolveActionWindowConfig(config: Config): ResolvedActionWindowConfig;
declare function resolveCoefficientConfig(config: Config): ResolvedCoefficientConfig;
declare function summarizeActionEntries(rawEntries: ActionEntry[] | undefined, windowMs: number, nowMs: number): SummarizedActions;
declare function appendActionEntry(entries: ActionEntry[] | undefined, action: ActionType | string, nowMs: number, maxEntries: number): ActionEntry[];
declare function computeShortTermReset(): number;
declare function computeDailyStreak(previousStreak: number | undefined, lastInteractionAt: Date | null | undefined, now: Date): number;
declare function computeCoefficientValue(coefConfig: ResolvedCoefficientConfig, streak: number, lastInteractionAt: Date | null | undefined, now: Date, todayIncreaseCount?: number, todayDecreaseCount?: number): CoefficientResult;
declare function composeState(longTerm: number, shortTerm: number, clampFn: (value: number) => number): CombinedState;
declare function formatActionCounts(counts: {
    increase?: number;
    decrease?: number;
}): string;

/**
 * 好感度数据存储
 * 提供按 scopeId + userId 读写的状态管理能力
 */

interface AffinityStoreOptions {
    ctx: Context;
    config: Config;
    log: LogFn;
}
declare function createAffinityStore(options: AffinityStoreOptions): {
    clamp: (value: number) => number;
    save: (seed: SessionSeed, value: number, specialRelation?: string, extra?: Partial<SaveExtra>) => Promise<AffinityRecord | null>;
    load: (scopeId: string, userId: string) => Promise<AffinityRecord | null>;
    ensure: (scopeId: string, session: Session, clampFn: ClampFn, fallbackInitial?: number) => Promise<AffinityState>;
    ensureForSeed: (seed: SessionSeed, userId: string, clampFn: ClampFn, fallbackInitial?: number) => Promise<AffinityState>;
    ensureForUser: (scopeId: string, session: Session, userId: string, clampFn: ClampFn, fallbackInitial?: number) => Promise<AffinityState>;
    recordInteraction: (seed: SessionSeed, userId: string) => Promise<AffinityRecord | null>;
    defaultInitial: () => number;
    randomInitial: () => number;
    initialRange: () => InitialRange;
    composeState: (longTerm: number, shortTerm: number) => CombinedState;
    createInitialState: (base: number) => CombinedState;
    extractState: (record: AffinityRecord | null) => AffinityState;
    displayAffinity: (record: Pick<AffinityRecord, "affinity" | "longTermAffinity">) => number;
};
type AffinityStore = ReturnType<typeof createAffinityStore>;

/**
 * 好感度增量应用
 * 提供基于 XML 参数的好感度更新函数，不依赖当前会话上下文
 */

interface ApplyAffinityDeltaParams {
    seed: SessionSeed;
    userId: string;
    delta: number;
    action: "increase" | "decrease";
    store: {
        ensureForSeed: (seed: SessionSeed, userId: string, clampFn: (value: number, low: number, high: number) => number) => Promise<{
            longTermAffinity?: number;
            shortTermAffinity?: number;
            chatCount?: number;
            actionStats?: ActionStats;
            coefficientState?: CoefficientState;
            lastInteractionAt?: Date | null;
        }>;
        save: (seed: SessionSeed, value: number, relation: string, extra?: Record<string, unknown>) => Promise<unknown>;
        clamp: (value: number) => number;
    };
    maxActionEntries: number;
    shortTermConfig: {
        disableShortTermAffinity?: boolean;
        promoteThreshold: number;
        demoteThreshold: number;
        longTermPromoteStep: number;
        longTermDemoteStep: number;
    };
    coefficientConfig?: {
        disableAffinityCoefficient: boolean;
        base: number;
        maxDrop: number;
        maxBoost: number;
        decayPerDay: number;
        boostPerDay: number;
        min: number;
        max: number;
    };
    log?: LogFn;
}
interface ApplyAffinityDeltaResult {
    success: boolean;
    message: string;
    shortTermAffinity?: number;
    longTermAffinity?: number;
    combinedAffinity?: number;
    coefficient?: number;
    delta?: number;
    actionStats?: ActionStats;
}
declare function applyAffinityDelta(params: ApplyAffinityDeltaParams): Promise<ApplyAffinityDeltaResult>;

/**
 * 黑名单数据库服务
 * 提供按 scopeId 隔离的永久/临时黑名单读写能力
 */

interface BlacklistServiceOptions {
    ctx: Context;
    config: Config;
    log: LogFn;
}
declare function createBlacklistService(options: BlacklistServiceOptions): {
    shouldBlock: (platform: string, userId: string) => Promise<boolean>;
    isBlacklisted: (platform: string, userId: string) => Promise<boolean>;
    isTemporarilyBlacklisted: (platform: string, userId: string) => Promise<TemporaryBlacklistEntry | null>;
    listPermanent: (platform?: string) => Promise<BlacklistEntry[]>;
    listTemporary: (platform?: string) => Promise<TemporaryBlacklistEntry[]>;
    recordPermanent: (platform: string, userId: string, detail?: BlacklistDetail) => Promise<BlacklistEntry | null>;
    removePermanent: (platform: string, userId: string) => Promise<boolean>;
    recordTemporary: (platform: string, userId: string, durationHours: number, penalty: number, detail?: BlacklistDetail) => Promise<TemporaryBlacklistEntry | null>;
    removeTemporary: (platform: string, userId: string) => Promise<boolean>;
    clearAll: () => Promise<void>;
};
type BlacklistService = ReturnType<typeof createBlacklistService>;

/**
 * 黑名单拦截中间件
 * 提供消息拦截守卫，阻止黑名单用户的消息
 */

interface BlacklistGuardOptions {
    config: Config;
    blacklist: BlacklistService;
    log: LogFn;
}
declare function createBlacklistGuard(options: BlacklistGuardOptions): {
    shouldBlock: (session: Session) => Promise<boolean>;
    middleware: (session: Session, next: () => Promise<void>) => Promise<void>;
};
type BlacklistGuard = ReturnType<typeof createBlacklistGuard>;

/**
 * 永久黑名单解除编排
 * 统一处理解封后的好感度重置与缓存清理
 */

interface UnblockPermanentDeps {
    config: Config;
    log: LogFn;
    store: AffinityStore;
    cache: AffinityCache;
    blacklist: BlacklistService;
}
interface UnblockPermanentInput {
    source: "command" | "xml" | "native";
    platform: string;
    userId: string;
    seed?: SessionSeed;
}
interface UnblockPermanentResult {
    removed: boolean;
    affinityReset: boolean;
    affinity: number | null;
}
declare function createPermanentUnblockHandler(deps: UnblockPermanentDeps): (input: UnblockPermanentInput) => Promise<UnblockPermanentResult>;

/**
 * 关系等级解析器
 * 根据好感度值或关系名称解析对应的关系等级配置
 */

declare function createLevelResolver(config: Config): {
    resolveLevelByAffinity: (value: number) => RelationshipLevel | null;
    resolveLevelByRelation: (relationName: string) => RelationshipLevel | null;
};
type LevelResolver = ReturnType<typeof createLevelResolver>;

/**
 * 手动关系配置管理
 * 提供特殊关系的配置管理和数据库同步功能
 */

interface ManualConfigOptions {
    ctx: Context;
    config: Config;
    log: LogFn;
}
declare function createManualRelationshipManager(options: ManualConfigOptions): {
    find: (_platform: string, userId: string) => ManualRelationship | null;
    update: (userId: string, relationName: string) => void;
    remove: (userId: string) => Promise<boolean>;
    syncToDatabase: () => Promise<void>;
};
type ManualRelationshipManager = ReturnType<typeof createManualRelationshipManager>;

/**
 * 消息历史记录
 * 提供会话级别的消息历史缓存和查询功能
 */

interface HistoryEntry {
    userId: string;
    username: string;
    content: string;
    timestamp: number;
}
interface MessageHistoryOptions {
    ctx: Context;
    config: Config;
    log: LogFn;
}
declare function createMessageHistory(options: MessageHistoryOptions): {
    record: (session: Session) => void;
    fetch: (_session: Session) => Promise<string[]>;
    fetchEntries: (session: Session, count: number) => Promise<HistoryEntry[]>;
    clear: (session: Session) => void;
};
type MessageHistory = ReturnType<typeof createMessageHistory>;

/**
 * 消息存储
 * 提供带消息 ID 的消息存储，支持按内容或位置查找消息
 */

interface StoredMessage {
    messageId: string;
    userId: string;
    username: string;
    content: string;
    timestamp: number;
}
interface MessageStoreOptions {
    ctx: Context;
    log: LogFn;
    limit?: number;
}
declare function createMessageStore(options: MessageStoreOptions): {
    record: (session: Session) => void;
    getMessages: (session: Session, count?: number) => StoredMessage[];
    findByLastN: (session: Session, lastN: number, userId?: string) => StoredMessage | null;
    findByIds: (session: Session, messageIds: string[]) => StoredMessage[];
    findByContent: (session: Session, keyword: string, userId?: string) => StoredMessage | null;
    clear: (session: Session) => void;
};
type MessageStore = ReturnType<typeof createMessageStore>;

/**
 * 基于 temp 的模型响应适配层
 * 通过共享 runtime 框架监听 AI 回复写入
 */

interface SessionLike {
    userId?: string;
    selfId?: string;
    platform?: string;
    guildId?: string;
    username?: string;
    bot?: unknown;
}
interface GroupTempLike extends TempLike {
    completionMessages?: CompletionMessagesLike;
}
interface CharacterServiceLike extends CharacterServiceLike$1<GroupTempLike> {
}
interface ModelResponseContext {
    response: string;
    session: SessionLike | null;
}
interface CharacterTempModelResponseRuntime {
    start: () => boolean;
    stop: () => void;
    isActive: () => boolean;
}
interface CharacterTempModelResponseRuntimeParams {
    getCharacterService: () => CharacterServiceLike | null | undefined;
    processModelResponse: (context: ModelResponseContext) => Promise<void>;
    log?: LogFn;
    logActivation?: boolean;
}
declare function createCharacterTempModelResponseRuntime(params: CharacterTempModelResponseRuntimeParams): CharacterTempModelResponseRuntime;

/**
 * 模型响应处理器
 * 负责解析 XML 动作并执行好感度、黑名单、关系与昵称更新
 */

interface ModelResponseProcessorParams {
    config: Config;
    cache: {
        clear: (scopeId: string, userId: string) => void;
    };
    store: {
        ensureForSeed: Parameters<typeof applyAffinityDelta>[0]["store"]["ensureForSeed"];
        recordInteraction: (seed: Parameters<typeof applyAffinityDelta>[0]["seed"], userId: string) => Promise<unknown>;
        save: (seed: Parameters<typeof applyAffinityDelta>[0]["seed"], value: number, relation?: string, extra?: Record<string, unknown>) => Promise<unknown>;
        clamp: Parameters<typeof applyAffinityDelta>[0]["store"]["clamp"];
        load: (scopeId: string, userId: string) => Promise<{
            affinity?: number | null;
            longTermAffinity?: number | null;
            nickname?: string | null;
            specialRelation?: string | null;
        } | null | undefined>;
    };
    blacklist: {
        removeTemporary: (platform: string, userId: string) => Promise<unknown>;
        recordPermanent: (platform: string, userId: string, detail: {
            note: string;
            nickname: string;
        }) => Promise<unknown>;
        recordTemporary: (platform: string, userId: string, durationHours: number, penalty: number, detail: {
            note: string;
            nickname: string;
        }) => Promise<unknown>;
    };
    unblockPermanent: (params: {
        source: "xml" | "command" | "native";
        platform: string;
        userId: string;
        seed?: SessionSeed;
    }) => Promise<UnblockPermanentResult>;
    userAlias: {
        setAlias: (platform: string, userId: string, alias: string) => Promise<unknown>;
    };
    shortTermConfig: {
        disableShortTermAffinity?: boolean;
        promoteThreshold: number;
        demoteThreshold: number;
        longTermPromoteStep: number;
        longTermDemoteStep: number;
    };
    actionWindowConfig: {
        maxEntries: number;
    };
    coefficientConfig?: {
        disableAffinityCoefficient: boolean;
        base: number;
        maxDrop: number;
        maxBoost: number;
        decayPerDay: number;
        boostPerDay: number;
        min: number;
        max: number;
    };
    shouldExecuteXmlActions?: () => boolean;
    log: LogFn;
}
declare function resolveXmlScopeId(attrs: Record<string, string>, config: Config): string | null;
declare function createModelResponseProcessor(params: ModelResponseProcessorParams): (context: ModelResponseContext) => Promise<void>;

/**
 * 回复参数工具注册
 * 将 affinity XML 工具动作挂载到 chatluna-character 实验性 reply tool 字段
 */

type RegisterDeps = Pick<ModelResponseProcessorParams, "config" | "cache" | "store" | "blacklist" | "unblockPermanent" | "userAlias" | "shortTermConfig" | "actionWindowConfig" | "coefficientConfig"> & {
    ctx: Context;
    log?: LogFn;
};
declare function hasReplyToolsEnabled(config: Config): boolean;
declare function registerCharacterReplyTools(deps: RegisterDeps): () => void;

/**
 * Character 系统提示词注入
 * 分别注册 XML 参考提示词与好感度机制说明，两者互不依赖
 */

declare function buildAffinityMechanismPrompt(config: Config): string;
interface RegisterPromptDeps {
    ctx: Context;
    config: Config;
    log?: LogFn;
}
interface RegisterCharacterPromptInjectionDeps extends RegisterPromptDeps {
    replaceScopeId?: boolean;
}
declare function registerCharacterPromptInjection(deps: RegisterCharacterPromptInjectionDeps): (() => void) | null;
declare function registerAffinityMechanismPromptInjection(deps: RegisterPromptDeps): (() => void) | null;

interface ToolDefaultAvailability {
    enabled: true;
    main: true;
    chatluna: true;
    characterScope: "all";
}
interface NativeToolMeta {
    source: "extension";
    group: string;
    tags: string[];
    defaultAvailability: ToolDefaultAvailability;
}
interface NativeToolRegistration {
    selector: () => boolean;
    authorization: () => boolean;
    description: string;
    createTool: () => unknown;
    meta: NativeToolMeta;
}
interface RegisterNativeToolsDeps extends Pick<ModelResponseProcessorParams, "config" | "cache" | "store" | "blacklist" | "unblockPermanent" | "userAlias" | "shortTermConfig" | "actionWindowConfig" | "coefficientConfig"> {
    ctx: Context;
    plugin: {
        registerTool: (name: string, tool: NativeToolRegistration) => (() => void) | void;
    };
    log?: LogFn;
}
declare function registerNativeTools(deps: RegisterNativeToolsDeps): () => void;

/**
 * 用户自定义昵称数据库服务
 * 提供自定义昵称的读写能力
 */

interface UserAliasServiceOptions {
    ctx: Context;
    scopeId: string;
    log: LogFn;
}
declare function createUserAliasService(options: UserAliasServiceOptions): {
    getAlias: (_platform: string, userId: string) => Promise<string | null>;
    setAlias: (platform: string, userId: string, alias: string) => Promise<UserAliasRecord>;
};
type UserAliasService = ReturnType<typeof createUserAliasService>;

/**
 * 数据迁移服务
 * 将旧表数据迁移到 *_v2 新表并记录迁移状态
 */

interface MigrationOptions {
    ctx: Context;
    scopeId: string;
    log: LogFn;
}
declare function createMigrationService(options: MigrationOptions): {
    run: () => Promise<void>;
};

/**
 * 活跃作用域协调器
 * 在同一 Koishi 根上下文中协调固定名称的 ChatLuna 工具注册权
 */

interface ScopeRegistrationState {
    isOnlyScope: boolean;
    isOwner: boolean;
}
declare function registerActiveScope(ctx: Context, scopeId: string, notify: (state: ScopeRegistrationState) => void): () => void;

/**
 * 表格渲染器
 * 渲染通用表格图片
 */

interface TableRenderOptions {
    heading?: string;
    subHeading?: string;
}
declare function createTableRenderer(log?: LogFn): (title: string, headers: string[], rows: string[][], options?: TableRenderOptions) => Promise<Buffer | null>;
type TableRenderer = ReturnType<typeof createTableRenderer>;

/**
 * 黑名单渲染器
 * 渲染黑名单列表图片
 */

interface BlacklistItem {
    index: number;
    nickname: string;
    userId: string;
    timeInfo: string;
    note: string;
    avatarUrl?: string;
    isTemp?: boolean;
    penalty?: number;
    tag?: string;
}
declare function createBlacklistRenderer(log?: LogFn): (title: string, items: BlacklistItem[]) => Promise<Buffer | null>;
type BlacklistRenderer = ReturnType<typeof createBlacklistRenderer>;

/**
 * 详情渲染器
 * 渲染好感度详情卡片图片
 */

interface InspectData {
    userId: string;
    nickname: string;
    platform: string;
    relation: string;
    compositeAffinity: number;
    longTermAffinity: number;
    shortTermAffinity: number;
    coefficient: number;
    streak: number;
    chatCount: number;
    lastInteraction: string;
    avatarUrl?: string;
    impression?: string;
}
declare function createInspectRenderer(log?: LogFn): (data: InspectData) => Promise<Buffer | null>;
type InspectRenderer = ReturnType<typeof createInspectRenderer>;

/**
 * 排行榜渲染器
 * 渲染好感度排行榜图片
 */

interface RankItem {
    rank: number;
    name: string;
    relation: string;
    affinity: number;
    avatarUrl?: string;
}
declare function createRankListRenderer(log?: LogFn): (title: string, items: RankItem[]) => Promise<Buffer | null>;
type RankListRenderer = ReturnType<typeof createRankListRenderer>;

/**
 * 公共 CSS 样式
 * 提供所有渲染器共用的基础样式定义
 */
declare const COMMON_STYLE = "\n  * { box-sizing: border-box; margin: 0; padding: 0; }\n\n  body {\n    font-family: \"Noto Sans SC\", sans-serif;\n    background: #f0f2f5;\n    color: #1f2937;\n  }\n\n  .container {\n    padding: 32px;\n    width: 600px;\n    background: #f0f2f5;\n    display: flex;\n    flex-direction: column;\n    gap: 16px;\n    font-feature-settings: \"palt\";\n  }\n\n  .header {\n    margin-bottom: 8px;\n    padding: 0 8px;\n  }\n\n  h1 {\n    font-size: 24px;\n    margin: 0;\n    font-weight: 700;\n    color: #111827;\n    display: flex;\n    align-items: center;\n    gap: 8px;\n  }\n  \n  h2 {\n    font-size: 16px;\n    font-weight: 500;\n    color: #6b7280;\n    margin-top: 4px;\n  }\n\n  .card {\n    background: #ffffff;\n    border-radius: 12px;\n    padding: 16px;\n    display: flex;\n    align-items: center;\n    gap: 16px;\n    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);\n  }\n\n  .avatar {\n    width: 48px;\n    height: 48px;\n    border-radius: 50%;\n    object-fit: cover;\n    border: 2px solid #e5e7eb;\n    flex-shrink: 0;\n  }\n  \n  .avatar-placeholder {\n    width: 48px;\n    height: 48px;\n    border-radius: 50%;\n    background: #f3f4f6;\n    flex-shrink: 0;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    color: #9ca3af;\n    font-weight: 600;\n    font-size: 20px;\n    border: 2px solid #e5e7eb;\n  }\n\n  .info {\n    flex: 1;\n    display: flex;\n    flex-direction: column;\n    gap: 4px;\n    min-width: 0;\n  }\n\n  .name-row {\n    display: flex;\n    align-items: center;\n    gap: 8px;\n  }\n\n  .name {\n    font-size: 16px;\n    font-weight: 600;\n    color: #111827;\n    white-space: nowrap;\n    overflow: hidden;\n    text-overflow: ellipsis;\n  }\n  \n  .sub-text {\n    font-size: 12px;\n    color: #6b7280;\n  }\n\n  .badge {\n    font-size: 12px;\n    padding: 2px 8px;\n    background: #e0e7ff;\n    color: #4f46e5;\n    border-radius: 999px;\n    font-weight: 500;\n    white-space: nowrap;\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n  }\n  \n  .badge-red {\n    background: #fee2e2;\n    color: #ef4444;\n  }\n\n  .badge-orange {\n    background: #ffedd5;\n    color: #f97316;\n  }\n  \n  .badge-gray {\n    background: #f3f4f6;\n    color: #6b7280;\n  }\n\n  .value-container {\n    text-align: right;\n    display: flex;\n    flex-direction: column;\n    align-items: flex-end;\n    justify-content: center;\n    flex-shrink: 0;\n  }\n\n  .value-primary {\n    font-size: 18px;\n    font-weight: 700;\n    color: #ec4899;\n    font-feature-settings: \"tnum\";\n  }\n  \n  .value-secondary {\n    font-size: 14px;\n    font-weight: 600;\n    color: #4b5563;\n  }\n\n  .label-small {\n    font-size: 12px;\n    color: #6b7280;\n  }\n\n  .stat-label {\n    font-size: 12px;\n    color: #6b7280;\n    margin-top: 4px;\n  }\n";

/**
 * Takumi 渲染基础工具
 * 负责复用渲染器、加载中日韩字体并准备远程图片资源
 */

interface RenderOptions {
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
}
declare function renderHtml(html: string, options: RenderOptions, log?: LogFn): Promise<Buffer | null>;

interface RenderServiceOptions {
    log?: LogFn;
}
declare function createRenderService(options: RenderServiceOptions): {
    rankList: (title: string, items: RankItem[]) => Promise<Buffer | null>;
    inspect: (data: InspectData) => Promise<Buffer | null>;
    blacklist: (title: string, items: BlacklistItem[]) => Promise<Buffer | null>;
    table: (title: string, headers: string[], rows: string[][], options?: TableRenderOptions) => Promise<Buffer | null>;
};
type RenderService = ReturnType<typeof createRenderService>;

/**
 * 命令模块类型定义
 * 定义命令注册所需的依赖和上下文类型
 */

interface CommandDependencies {
    ctx: Context;
    config: Config;
    log: LogFn;
    store: AffinityStore;
    cache: AffinityCache;
    renders: RenderService;
    fetchMember: (session: Session, userId: string) => Promise<MemberInfo | null>;
    resolveUserIdentity: (session: Session, input: string) => Promise<{
        userId: string;
        nickname: string;
    } | null>;
    findMemberByName: (session: Session, name: string) => Promise<{
        userId: string;
        nickname: string;
    } | null>;
    fetchGroupMemberIds: (session: Session) => Promise<Set<string> | null>;
    resolveGroupId: (session: Session) => string;
    stripAtPrefix: (text: string) => string;
    unblockPermanent: (input: {
        source: "command" | "xml" | "native";
        platform: string;
        userId: string;
        seed?: SessionSeed;
    }) => Promise<UnblockPermanentResult>;
}
interface RankLineItem {
    name: string;
    relation: string;
    affinity: number;
    userId: string;
}
interface BlacklistEnrichedItem {
    userId: string;
    nickname: string;
    blockedAt?: string;
    note?: string;
    platform?: string;
}

/**
 * 排行榜命令
 * 查看好感度排行榜
 */

declare function registerRankCommand(deps: CommandDependencies): void;

/**
 * 详情查看命令
 * 查看指定用户的好感度详情
 */

declare function registerInspectCommand(deps: CommandDependencies): void;

/**
 * 黑名单列表命令
 * 查看永久黑名单和临时黑名单
 */

interface BlacklistCommandDeps extends CommandDependencies {
    blacklist: BlacklistService;
}
declare function registerBlacklistCommand(deps: BlacklistCommandDeps): void;

/**
 * 拉黑与解除拉黑命令
 * 手动管理永久黑名单
 */

interface BlockCommandDeps extends CommandDependencies {
    blacklist: BlacklistService;
}
declare function registerBlockCommand(deps: BlockCommandDeps): void;

/**
 * 临时拉黑命令
 * 管理临时黑名单
 */

interface TempBlockCommandDeps extends CommandDependencies {
    blacklist: BlacklistService;
}
declare function registerTempBlockCommand(deps: TempBlockCommandDeps): void;

/**
 * 清空数据库命令
 * 清空所有好感度数据（危险操作，需二次确认）
 */

declare function registerClearAllCommand(deps: CommandDependencies): void;

/**
 * 调整好感度命令
 * 手动调整指定用户的好感度
 */

declare function registerAdjustCommand(deps: CommandDependencies): void;

/**
 * 好感度变量提供者
 * 为 ChatLuna 提供当前用户及上下文用户好感度变量
 */

interface ProviderConfigurable$2 {
    session?: Session;
}
interface AffinityProviderDeps {
    config: Config;
    cache: AffinityCache;
    store: AffinityStore;
    fetchEntries?: (session: Session, count: number) => Promise<HistoryEntry[]>;
    getUserAlias?: (scopeId: string, platform: string, userId: string) => Promise<string | null>;
}
declare function createAffinityProvider(deps: AffinityProviderDeps): (args: unknown[] | undefined, _variables: unknown, configurable?: ProviderConfigurable$2) => Promise<number | string>;
type AffinityProvider = ReturnType<typeof createAffinityProvider>;

/**
 * 好感度区间变量提供者
 * 提供当前用户的好感度区间、关系与备注
 */

interface ProviderConfigurable$1 {
    session?: {
        platform?: string;
        userId?: string;
        selfId?: string;
    };
}
interface RelationshipLevelProviderDeps {
    store: AffinityStore;
    config: Config;
}
declare function createRelationshipLevelProvider(deps: RelationshipLevelProviderDeps): (args: unknown[] | undefined, _variables: unknown, configurable?: ProviderConfigurable$1) => Promise<string>;
type RelationshipLevelProvider = ReturnType<typeof createRelationshipLevelProvider>;

/**
 * 黑名单列表变量提供者
 * 为 ChatLuna 提供当前群黑名单列表信息
 */

interface ProviderConfigurable {
    session?: Session;
}
interface BlacklistListProviderDeps {
    scopeId: string;
    config: Config;
    store: AffinityStore;
    blacklist: BlacklistService;
}
declare function createBlacklistListProvider(deps: BlacklistListProviderDeps): (args: unknown[] | undefined, _variables: unknown, configurable?: ProviderConfigurable) => Promise<string>;
type BlacklistListProvider = ReturnType<typeof createBlacklistListProvider>;

/**
 * OneBot API 工具函数
 * 提供 OneBot 平台 API 调用的辅助函数
 */

type OneBotProtocol = 'napcat' | 'llbot';
interface OneBotInternal {
    _request?: (action: string, params: Record<string, unknown>) => Promise<unknown>;
    [key: string]: unknown;
}
declare function ensureOneBotSession(session: Session | null): {
    error?: string;
    session?: Session;
    internal?: OneBotInternal;
};
declare function callOneBotAPI(internal: OneBotInternal, action: string, params: Record<string, unknown>, fallbacks?: string[]): Promise<unknown>;

/**
 * 插件入口
 * 导出插件元信息和 apply 函数
 */

declare const usage = "\n## \u4F7F\u7528\u8BF4\u660E\n\n\u9996\u6B21\u4F7F\u7528\u524D\u8BF7\u5148\u9605\u8BFB [readme.md](https://github.com/Sor85/AAAAACAT-chatluna-plugins/blob/main/plugins/chatluna-affinity/readme.md)\uFF0C\u6309\u6587\u6863\u5B8C\u6210\u4F9D\u8D56\u5B89\u88C5\u3001`scopeId` \u914D\u7F6E\u3001\u53D8\u91CF\u6CE8\u5165\u548C XML \u5DE5\u5177\u63A5\u5165\u3002\n\n\u6309\u4F60\u7684\u4F7F\u7528\u5165\u53E3\u9009\u62E9\u5BF9\u5E94\u6307\u5357\uFF1A\n\n- \u4F7F\u7528 ChatLuna Character\uFF1A\u67E5\u770B [ChatLuna Character \u63A5\u5165\u6307\u5357](https://github.com/Sor85/AAAAACAT-chatluna-plugins/blob/main/plugins/chatluna-affinity/docs/character-prompt-guide.md)\n- \u4F7F\u7528 ChatLuna \u4E3B\u63D2\u4EF6\uFF1A\u67E5\u770B [ChatLuna \u4E3B\u63D2\u4EF6\u63A5\u5165\u6307\u5357](https://github.com/Sor85/AAAAACAT-chatluna-plugins/blob/main/plugins/chatluna-affinity/docs/chatluna-plugin-guide.md)\n";

export { ACTION_WINDOW_DEFAULTS, AFFINITY_DEFAULTS, AFFINITY_DYNAMICS_DEFAULTS, ALL_MEMBER_INFO_ITEMS, type ActionCounts, type ActionEntry, type ActionStats, type ActionType, type ActionWindowConfig, type AffinityCache, type AffinityDynamicsConfig, type AffinityProvider, type AffinityProviderDeps, type AffinityRecord, AffinitySchema, type AffinityState, type AffinityStore, type AffinityStoreOptions, type ApplyAffinityDeltaParams, type ApplyAffinityDeltaResult, BASE_AFFINITY_DEFAULTS, BLACKLIST_MODEL_NAME, BLACKLIST_MODEL_NAME_V2, BLACKLIST_REPLY_TEMPLATE, type BlacklistCommandDeps, type BlacklistDetail, type BlacklistEnrichedItem, type BlacklistEntry, type BlacklistGuard, type BlacklistGuardOptions, type BlacklistItem, type BlacklistListProvider, type BlacklistListProviderDeps, type BlacklistMode, type BlacklistRecord, type BlacklistRenderer, BlacklistSchema, type BlacklistService, type BlacklistServiceOptions, type BlockCommandDeps, CLOUD_TYPES, COEFFICIENT_DEFAULTS, COMMON_STYLE, type CharacterTempModelResponseRuntime, type CharacterTempModelResponseRuntimeParams, type ClampFn, type CoefficientConfig, type CoefficientResult, type CoefficientState, type CombinedState, type CommandDependencies, ConfigSchema as Config, ConfigSchema, DASHBOARD_SNAPSHOT_MODEL_NAME, DEFAULT_MEMBER_INFO_ITEMS, type DashboardSnapshotRecord, FETCH_CONSTANTS, type HistoryEntry, type InMemoryTemporaryEntry, type InitialRange, type InspectData, type InspectRenderer, type LegacyAffinityRecord, type LegacyBlacklistRecord, type LegacyUserAliasRecord, type LevelResolver, type LogFn, type LogLevel, MIGRATION_MODEL_NAME, MODEL_NAME, MODEL_NAME_V2, type ManualConfigOptions, type ManualRelationship, type ManualRelationshipManager, type MemberInfo, type MemberInfoField, type MessageHistory, type MessageHistoryOptions, type MessageStore, type MessageStoreOptions, type MigrationOptions, type MigrationRecord, type ModelResponseContext, type ModelResponseProcessorParams, type NativeToolItemConfig, type NativeToolKey, type NativeToolRegistration, type NativeToolSettings, NativeToolSettingsSchema, type OneBotInternal, type OneBotProtocol, OtherSettingsSchema, RENDER_CONSTANTS, ROLE_MAPPING, type RankItem, type RankLineItem, type RankListRenderer, type RegisterCharacterPromptInjectionDeps, type RegisterNativeToolsDeps, type RelationshipLevel, type RelationshipLevelProvider, type RelationshipLevelProviderDeps, RelationshipSchema, type RenderMemberInfoOptions, type RenderOptions, type RenderService, type RenderServiceOptions, type ResolvedActionWindowConfig, type ResolvedCoefficientConfig, type ResolvedShortTermConfig, type RoleMapping, type RoleTranslation, SHORT_TERM_DEFAULTS, type SaveExtra, type ScopeRegistrationState, type SessionSeed, type ShortTermConfig, type StoredMessage, type SummarizedActions, THRESHOLDS, TIME_CONSTANTS, TIMING_CONSTANTS, type TableRenderOptions, type TableRenderer, type TempBlockCommandDeps, type TemporaryBlacklistEntry, USER_AFFINITY_SNAPSHOT_MODEL_NAME, USER_ALIAS_MODEL_NAME, USER_ALIAS_MODEL_NAME_V2, type UnblockPermanentDeps, type UnblockPermanentInput, type UnblockPermanentResult, type UserAffinitySnapshotRecord, type UserAliasRecord, type UserAliasService, type UserAliasServiceOptions, type VariableSettings, type XmlToolSettings, XmlToolSettingsSchema, appendActionEntry, apply, applyAffinityDelta, assertScopeId, buildAffinityMechanismPrompt, buildScopedCommandName, callOneBotAPI, clamp, clampFloat, collectNicknameCandidates, collectRoleCandidates, composeState, computeCoefficientValue, computeDailyStreak, computeShortTermReset, createAffinityCache, createAffinityProvider, createAffinityStore, createBlacklistGuard, createBlacklistListProvider, createBlacklistRenderer, createBlacklistService, createCharacterTempModelResponseRuntime, createInspectRenderer, createLevelResolver, createLogger, createManualRelationshipManager, createMessageHistory, createMessageStore, createMigrationService, createModelResponseProcessor, createPermanentUnblockHandler, createRankListRenderer, createRelationshipLevelProvider, createRenderService, createTableRenderer, createUserAliasService, dayNumber, ensureOneBotSession, escapeHtml, extendAffinityModel, extendBlacklistModel, extendDashboardSnapshotModel, extendMigrationModel, extendUserAliasModel, fetchGroupMemberIds, fetchMember, findMemberByName, formatActionCounts, formatBeijingTimestamp, formatDateOnly, formatDateTime, formatTimestamp, getChannelId, getDateString, getGuildId, getPlatform, getRoleDisplay, getSelfId, getTimeString, getUserId, hasReplyToolsEnabled, inject, isFiniteNumber, isValidScopeId, makeUserKey, name, normalizeScopeId, normalizeTimestamp, pickFirst, registerActiveScope, registerAdjustCommand, registerAffinityMechanismPromptInjection, registerBlacklistCommand, registerBlockCommand, registerCharacterPromptInjection, registerCharacterReplyTools, registerClearAllCommand, registerInspectCommand, registerModels, registerNativeTools, registerRankCommand, registerTempBlockCommand, renderHtml, renderInfoField, renderMemberInfo, renderTemplate, resolveActionWindowConfig, resolveBotInfo, resolveCoefficientConfig, resolveGroupId, resolveRoleLabel, resolveScopedVariableArgs, resolveShortTermConfig, resolveUserIdentity, resolveUserInfo, resolveXmlScopeId, roundTo, sanitizeChannel, stripAtPrefix, summarizeActionEntries, toDate, translateGender, translateRole, truncate, usage };
