import type { ReviewDocument } from './types.ts'

// 固定源码快照；更新样例必须同时重核业务说明、行号与指纹。
export const sampleReview: ReviewDocument = {
  "schemaVersion": 1,
  "id": "vast-psycho-system-level",
  "title": "通灵技能 · 共享总等级",
  "description": "用三个真实入口核对：升级、解锁与上阵分别改变哪些状态。业务语言由当前源码人工整理；L/U/E 为示意状态。",
  "revision": "worktree-4d5c5409a-887c3c3da061",
  "snapshot": {
    "repository": "Vast · feat/psycho-system-level",
    "commit": "4d5c5409a3b72e3ce719f19655d5a700c3836f34",
    "fingerprint": "887c3c3da0614300d0d12f147ef46778c11c08943918ecacaa539fc5b7100b66",
    "capturedAt": "2026-11-02T12:12:03Z",
    "dirty": false
  },
  "coverage": {
    "included": [
      "系统总等级升级及扣费前的校验出口",
      "技能解锁资格、重复解锁与资源检查",
      "上阵/卸下校验、缓存失效与共享等级效果查询"
    ],
    "excluded": [
      "转职与职业资格转换",
      "Build 配装、排行快照、导入导出及协议消费者",
      "客户端、Admin、真实存储与战斗运行时验收",
      "外部入口的完整调用链、并发、跨对象事务与线上配置有效性"
    ],
    "note": "这是固定工作区快照的源码说明，捕获时工作区干净；不是线上运行证明。知识图谱对应另一个检出，本样例已直接核对实际文件；尚未完成全工程覆盖，也不会自动监测 Vast 后续变化。"
  },
  "scenes": [
    {
      "id": "upgrade",
      "title": "升级总等级",
      "description": "没有解锁或上阵技能时，也能提升共享等级。"
    },
    {
      "id": "unlock",
      "title": "解锁新技能",
      "description": "增加解锁资格，保留总等级与原上阵选择。"
    },
    {
      "id": "equip",
      "title": "上阵与卸下",
      "description": "只切换一个选择，下次生成属性时使用当前总等级。"
    }
  ],
  "nodes": [
    {
      "id": "upgrade-start",
      "sceneId": "upgrade",
      "title": "发起总等级升级",
      "kind": "action",
      "summary": "无需先解锁或上阵技能。",
      "detail": "请求不选择某个技能，升级只处理当前化身的通灵系统总等级。示意状态：总等级 L；已解锁集合 U；上阵技能 E。L/U/E 为符号，不代表线上角色。",
      "input": "当前化身；等级 L；解锁 U；上阵 E",
      "output": "进入功能开关校验",
      "position": {
        "x": 0,
        "y": 0
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLevelUp",
          "startLine": 85,
          "endLine": 89,
          "digest": "701e02b88d7f53ee92935a7e30daacb80e5188813dd70d22a2be471208083f60"
        }
      ]
    },
    {
      "id": "upgrade-toggle",
      "sceneId": "upgrade",
      "title": "通灵功能是否开放？",
      "kind": "decision",
      "summary": "关闭时直接拒绝升级。",
      "detail": "先检查功能开关，关闭时返回“功能未开放”，不进入升级费用处理。",
      "input": "功能开关；现有养成状态",
      "output": "开放 → 继续；关闭 → 拒绝",
      "position": {
        "x": 0,
        "y": 180
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLevelUp",
          "startLine": 86,
          "endLine": 88,
          "digest": "5dfedb2a961674f343e39f88697d14ea62afcdee5ec7d84a5ed1ccb38f2acc83"
        }
      ]
    },
    {
      "id": "upgrade-level",
      "sceneId": "upgrade",
      "title": "等级与升级配置是否有效？",
      "kind": "decision",
      "summary": "缺省等级按 1；先判满级，再查配置。",
      "detail": "从升级费用表最大 ID 读取等级上限。已满级优先返回满级错误；否则当前等级行和下一等级行都必须存在。不会读取已解锁、上阵选择或技能效果表。",
      "input": "等级 L（缺省视为 1）；升级费用表",
      "output": "未满级且两行齐全 → 继续；满级或缺行 → 拒绝",
      "position": {
        "x": 0,
        "y": 360
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "GetPsychoSkillLevel / PsychoSkillLevelUp",
          "startLine": 77,
          "endLine": 99,
          "digest": "d3ddbd158e2a6795cad397461fa2682dd76d331418c9d2bded895b2f7df4fbcf"
        },
        {
          "path": "server/entry/extends/psycho_skill.go",
          "symbol": "GetPsychoSystemMaxLevel",
          "startLine": 15,
          "endLine": 22,
          "digest": "b965b5b7b88fd175606a2d3c53fa683aea2c87ffe10a91cc02dc45b0cdd6810f"
        }
      ]
    },
    {
      "id": "upgrade-cost",
      "sceneId": "upgrade",
      "title": "升级条件和资源是否满足？",
      "kind": "decision",
      "summary": "按当前等级行检查，全部通过后才扣费。",
      "detail": "检查当前等级行的解锁条件，再将本行费用转换并检查资源。旧技能效果表里的费用不参与本次升级。",
      "input": "当前等级行的条件与费用；现有资源",
      "output": "条件与资源充足 → 扣费；任一不足 → 拒绝",
      "position": {
        "x": 0,
        "y": 540
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLevelUp",
          "startLine": 100,
          "endLine": 106,
          "digest": "213ef4cb73b02211cd619fb33a811c2dd17663765d3bbdeee83bcd4f189524d2"
        },
        {
          "path": "server/servers/game/role/cost.go",
          "symbol": "CheckCosts",
          "startLine": 42,
          "endLine": 50,
          "digest": "8c0e4875b214498e02ab95e64610ea1cb8860f8e365bb1852bc030b2ce7592eb"
        }
      ]
    },
    {
      "id": "upgrade-apply",
      "sceneId": "upgrade",
      "title": "扣除费用，总等级增加 1",
      "kind": "action",
      "summary": "只改变资源与系统总等级。",
      "detail": "先执行当前等级行的资源扣除，再保存 L + 1。不新增解锁资格，不改变上阵技能。该片段未建立跨对象事务承诺。",
      "input": "等级 L；解锁 U；上阵 E；足够资源",
      "output": "等级 L + 1；解锁 U；上阵 E；资源扣除本行费用",
      "position": {
        "x": 0,
        "y": 720
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLevelUp",
          "startLine": 107,
          "endLine": 108,
          "digest": "824180a505994964fd80065a532db2282956b50b4c4ac419eb4495e41e2dd094"
        }
      ]
    },
    {
      "id": "upgrade-refresh",
      "sceneId": "upgrade",
      "title": "清除属性缓存并记录更新",
      "kind": "action",
      "summary": "下次生成属性时使用新等级。",
      "detail": "CalcRoleAtt 在这里使角色属性缓存失效；它不会立刻计算全部属性。随后调用现有更新入口。后续正常取属性时重算。",
      "input": "等级已变为 L + 1；可能存在旧属性缓存",
      "output": "旧缓存移除；调用角色更新；返回实际消耗",
      "position": {
        "x": 0,
        "y": 900
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLevelUp",
          "startLine": 109,
          "endLine": 111,
          "digest": "31b4c3d26b63296b5b6109b4cf54b6aadc9596f7086bdce29da534f7b8230980"
        },
        {
          "path": "server/servers/game/role/role.go",
          "symbol": "CalcRoleAtt",
          "startLine": 858,
          "endLine": 860,
          "digest": "bcc8d10ecd4b0b78c9cf082cd29b03aebeadcf07498b0cc220357b939d166703"
        },
        {
          "path": "server/servers/game/role/role_mgr.go",
          "symbol": "updateRoleInfo",
          "startLine": 66,
          "endLine": 68,
          "digest": "61e96ebe4fa28905a529f159ad24a79932abacac2861cd1a6460a29628584c6c"
        },
        {
          "path": "server/servers/game/role/role_mgr.go",
          "symbol": "GetRoleInfo",
          "startLine": 32,
          "endLine": 38,
          "digest": "35ad8d74368ea0f51711d14814d0c50773dbb8bbcbc84178274a25d9ff7f4661"
        }
      ]
    },
    {
      "id": "upgrade-complete",
      "sceneId": "upgrade",
      "title": "升级完成，解锁与上阵保持",
      "kind": "result",
      "summary": "没有技能也能升级；共享成长保留。",
      "detail": "业务结果：总等级只增加一级；U 与 E 保持原值。已有上阵技能的下次属性生成会以新的总等级查询效果。这里展示源码行为，不表示已经完成真实战斗验收。",
      "input": "升级操作成功",
      "output": "等级 L → L + 1；解锁 U → U；上阵 E → E",
      "position": {
        "x": 0,
        "y": 1080
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLevelUp",
          "startLine": 85,
          "endLine": 111,
          "digest": "2ef60c47c7751a17e98a61222161276786eaa3024f4b6ec73fd3db600a333d70"
        },
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "calcRolePsychoSkillAtt",
          "startLine": 122,
          "endLine": 133,
          "digest": "faf9b80ce0b25b1e2e4485a95235234e745d774386e5013c34b2cefc7425c3f5"
        }
      ]
    },
    {
      "id": "upgrade-rejected",
      "sceneId": "upgrade",
      "title": "拒绝升级，保留原有养成",
      "kind": "failure",
      "summary": "错误发生在本次扣费之前。",
      "detail": "可能原因：功能关闭、已满级、升级配置缺失、条件不满足或资源不足。返回对应错误；不执行本次扣费，不增加总等级，不改变解锁或上阵。",
      "input": "校验失败",
      "output": "等级仍为 L；解锁仍为 U；上阵仍为 E；不扣本次费用",
      "position": {
        "x": 360,
        "y": 400
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLevelUp",
          "startLine": 85,
          "endLine": 106,
          "digest": "2da7ab7749bbd8cdd17234e1973a578ec2ce36cb150a91ec1b0c1cce43a02ad0"
        }
      ]
    },
    {
      "id": "unlock-start",
      "sceneId": "unlock",
      "title": "选择要解锁的技能",
      "kind": "action",
      "summary": "解锁资格与系统等级独立。",
      "detail": "提交目标技能 S。当前等级可以已经较高；解锁流程不会读取或回写总等级。示意状态：总等级 L；已解锁集合 U；上阵技能 E。L/U/E 为符号，不代表线上角色。",
      "input": "目标技能 S；等级 L；解锁 U；上阵 E",
      "output": "进入解锁校验",
      "position": {
        "x": 0,
        "y": 0
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillUnlock",
          "startLine": 15,
          "endLine": 38,
          "digest": "7701642ba84f57386f51e1f4d9d5245a2484af300568e08f413a46469be59656"
        }
      ]
    },
    {
      "id": "unlock-eligible",
      "sceneId": "unlock",
      "title": "功能、技能与职业是否有效？",
      "kind": "decision",
      "summary": "功能开放，且技能属于当前职业。",
      "detail": "先检查功能开关，再检查技能 ID 为正、基础配置存在、配置职业集合包含当前化身职业。不依赖技能等级效果行。",
      "input": "功能开关；目标 S；技能基础表；当前职业",
      "output": "全部有效 → 查重；否则 → 拒绝",
      "position": {
        "x": 0,
        "y": 180
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillUnlock",
          "startLine": 16,
          "endLine": 22,
          "digest": "ba42824bdcec0e151d1fbf2db941ba478bc0436944b3bb8504d6e8f8b12d7f82"
        },
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "psychoSkillEntry",
          "startLine": 41,
          "endLine": 46,
          "digest": "29981c8f976a60c531e392404c030f92028f1ff8de0dbda992876437d02b1ec2"
        }
      ]
    },
    {
      "id": "unlock-duplicate",
      "sceneId": "unlock",
      "title": "这个技能是否尚未解锁？",
      "kind": "decision",
      "summary": "已解锁会先返回独立业务错误。",
      "detail": "已解锁时返回“技能已解锁”，不再检查首次解锁条件或费用。此顺序已按捕获时的工作区源码核对。",
      "input": "已解锁集合 U；目标 S",
      "output": "S 不在 U → 继续；S 已在 U → 拒绝",
      "position": {
        "x": 0,
        "y": 360
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillUnlock",
          "startLine": 23,
          "endLine": 27,
          "digest": "f5657cb642665357c123deed09f8419ea3c7ef5bca2c3fa52ae981e723f188e3"
        }
      ]
    },
    {
      "id": "unlock-cost",
      "sceneId": "unlock",
      "title": "首次解锁条件和资源是否满足？",
      "kind": "decision",
      "summary": "使用技能基础表的条件和费用。",
      "detail": "先检查该技能的解锁条件，再转换、校验其解锁费用；任一步失败都在扣费之前返回。",
      "input": "技能 S 的解锁条件、费用；现有资源",
      "output": "满足 → 扣费；不满足 → 拒绝",
      "position": {
        "x": 0,
        "y": 540
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillUnlock",
          "startLine": 28,
          "endLine": 34,
          "digest": "0686b58223a41136070852357ca15391bf0237077093358df10789b350c72dab"
        },
        {
          "path": "server/servers/game/role/cost.go",
          "symbol": "CheckCosts",
          "startLine": 42,
          "endLine": 50,
          "digest": "8c0e4875b214498e02ab95e64610ea1cb8860f8e365bb1852bc030b2ce7592eb"
        }
      ]
    },
    {
      "id": "unlock-apply",
      "sceneId": "unlock",
      "title": "扣除解锁费用，增加资格",
      "kind": "action",
      "summary": "只向已解锁集合加入技能 S。",
      "detail": "执行本次解锁费用扣除，随后将 S 的解锁标志记为真。没有总等级写入，也没有上阵选择写入。",
      "input": "等级 L；解锁 U；上阵 E；足够资源",
      "output": "等级 L；解锁 U ∪ {S}；上阵 E；扣除解锁费用",
      "position": {
        "x": 0,
        "y": 720
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillUnlock",
          "startLine": 35,
          "endLine": 36,
          "digest": "9707fbf4587fb8c488bc551645164c751de51c5f7680079c5765cd32d871c886"
        }
      ]
    },
    {
      "id": "unlock-update",
      "sceneId": "unlock",
      "title": "记录更新，保留现有属性缓存",
      "kind": "action",
      "summary": "新解锁技能不会自动生效。",
      "detail": "调用现有角色更新并返回实际消耗。本入口不调用 CalcRoleAtt；增加解锁资格本身不改变当前上阵效果。",
      "input": "技能 S 已解锁；原上阵 E",
      "output": "角色更新已调用；原上阵和属性缓存保持",
      "position": {
        "x": 0,
        "y": 900
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillUnlock",
          "startLine": 35,
          "endLine": 38,
          "digest": "8eda19db7422bccdaf0ad941b44e832767ac83c2bbe65b46d2e11fbff569f31b"
        }
      ]
    },
    {
      "id": "unlock-complete",
      "sceneId": "unlock",
      "title": "获得解锁资格，等级和上阵保持",
      "kind": "result",
      "summary": "新技能直接共享现有等级，但需要主动上阵。",
      "detail": "后续选择 S 上阵时，生成效果会使用当时的系统总等级。解锁本身既不降级、不补写缺省等级，也不自动把 S 上阵。",
      "input": "解锁操作成功",
      "output": "等级 L → L；解锁 U → U ∪ {S}；上阵 E → E",
      "position": {
        "x": 0,
        "y": 1080
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillUnlock",
          "startLine": 15,
          "endLine": 38,
          "digest": "7701642ba84f57386f51e1f4d9d5245a2484af300568e08f413a46469be59656"
        },
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "calcRolePsychoSkillAtt",
          "startLine": 122,
          "endLine": 133,
          "digest": "faf9b80ce0b25b1e2e4485a95235234e745d774386e5013c34b2cefc7425c3f5"
        }
      ]
    },
    {
      "id": "unlock-rejected",
      "sceneId": "unlock",
      "title": "拒绝解锁，不扣本次费用",
      "kind": "failure",
      "summary": "不重复收费，不额外授予资格。",
      "detail": "可能原因：功能关闭、技能或职业无效、已经解锁、首次解锁条件不足或资源不足。检查失败后不进入费用扣除与新增资格步骤。",
      "input": "任一解锁校验失败",
      "output": "等级 L、解锁 U、上阵 E 保持；不扣本次费用",
      "position": {
        "x": 360,
        "y": 400
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillUnlock",
          "startLine": 16,
          "endLine": 34,
          "digest": "3d9b0aedac40c12fe20efc865b6a1e993b53ad22646c056c0e32882bd6eeb9e9"
        },
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "psychoSkillEntry",
          "startLine": 41,
          "endLine": 46,
          "digest": "29981c8f976a60c531e392404c030f92028f1ff8de0dbda992876437d02b1ec2"
        }
      ]
    },
    {
      "id": "equip-start",
      "sceneId": "equip",
      "title": "选择上阵技能或主动卸下",
      "kind": "action",
      "summary": "一次只保存一个上阵选择。",
      "detail": "提交目标技能 S；S = 0 明确表示卸下。不会通过上阵操作提升系统等级、增加解锁资格或收取费用。示意状态：总等级 L；已解锁集合 U；上阵技能 E。L/U/E 为符号，不代表线上角色。",
      "input": "目标 S 或 0；等级 L；解锁 U；上阵 E",
      "output": "进入上阵校验",
      "position": {
        "x": 0,
        "y": 0
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "ValidatePsychoSkillLineUp / PsychoSkillLineUp",
          "startLine": 50,
          "endLine": 74,
          "digest": "ba5633a2984a68b1815bb9c474e1b8e7c728b1a06f5d6d3d9dd261b5badb61ff"
        }
      ]
    },
    {
      "id": "equip-toggle",
      "sceneId": "equip",
      "title": "通灵功能是否开放？",
      "kind": "decision",
      "summary": "关闭时，上阵和卸下都会被拒绝。",
      "detail": "功能开关检查在“0 表示卸下”判断之前。关闭功能时保留当前养成和选择，不接受这次变更。",
      "input": "功能开关；目标 S 或 0",
      "output": "开放 → 判断操作；关闭 → 拒绝",
      "position": {
        "x": 0,
        "y": 180
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "ValidatePsychoSkillLineUp",
          "startLine": 50,
          "endLine": 55,
          "digest": "9ac664693dd59f443e24690888ca599f4cef6265874f711517fd2022bfd72a0a"
        }
      ]
    },
    {
      "id": "equip-route",
      "sceneId": "equip",
      "title": "是否选择了“卸下”？",
      "kind": "decision",
      "summary": "目标为 0 时直接通过资格校验。",
      "detail": "卸下不要求当前有已解锁技能，也不查询目标技能配置。非 0 的上阵目标继续验证基础配置、职业与已解锁资格。",
      "input": "目标技能 ID",
      "output": "0 → 保存卸下；非 0 → 校验技能资格",
      "position": {
        "x": 0,
        "y": 360
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "ValidatePsychoSkillLineUp",
          "startLine": 54,
          "endLine": 64,
          "digest": "88adedf35e69a58a806c8ef8de41b9a6a8ca134fb8bc05348e86e88dd9d45c40"
        }
      ]
    },
    {
      "id": "equip-eligible",
      "sceneId": "equip",
      "title": "技能是否有效且已经解锁？",
      "kind": "decision",
      "summary": "符合当前职业，并已拥有解锁资格。",
      "detail": "基础配置必须存在，ID 为正，当前职业在配置的职业集合内，并且目标技能已解锁。这里不重查解锁条件，不查等级效果配置。",
      "input": "目标 S；基础配置；当前职业；集合 U",
      "output": "合法且 S 在 U → 保存；否则 → 拒绝",
      "position": {
        "x": 0,
        "y": 540
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "ValidatePsychoSkillLineUp",
          "startLine": 57,
          "endLine": 64,
          "digest": "698ca2441f056fcd49bd4ebbbbc854fe5359a4d45afa1fc3071273081fe966ed"
        },
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "psychoSkillEntry",
          "startLine": 41,
          "endLine": 46,
          "digest": "29981c8f976a60c531e392404c030f92028f1ff8de0dbda992876437d02b1ec2"
        }
      ]
    },
    {
      "id": "equip-apply",
      "sceneId": "equip",
      "title": "保存唯一上阵选择",
      "kind": "action",
      "summary": "只替换 E，等级、资格与资源保持。",
      "detail": "校验通过后，将上阵 ID 保存为 S 或 0。此入口不写总等级与解锁集合，也没有费用处理。",
      "input": "等级 L；解锁 U；原上阵 E",
      "output": "等级 L；解锁 U；上阵 S（或 0）；资源保持",
      "position": {
        "x": 0,
        "y": 720
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLineUp",
          "startLine": 67,
          "endLine": 74,
          "digest": "ddac5f2890c9f762bd2b095f345868fe175994a2bd5032d817a6164f5ebc22b5"
        }
      ]
    },
    {
      "id": "equip-refresh",
      "sceneId": "equip",
      "title": "清除属性缓存并记录更新",
      "kind": "action",
      "summary": "下次读取时按新选择生成属性。",
      "detail": "使旧属性缓存失效，随后调用角色更新。普通上阵和卸下使用相同的缓存更新路径。",
      "input": "新上阵 S 或 0；可能存在旧属性缓存",
      "output": "旧缓存移除；角色更新已调用",
      "position": {
        "x": 0,
        "y": 900
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "PsychoSkillLineUp",
          "startLine": 71,
          "endLine": 74,
          "digest": "25834fe55c14a33a33c1ff06250dd611e1edccf0bbdd4c423e32215f627a9b2f"
        },
        {
          "path": "server/servers/game/role/role.go",
          "symbol": "CalcRoleAtt",
          "startLine": 858,
          "endLine": 860,
          "digest": "bcc8d10ecd4b0b78c9cf082cd29b03aebeadcf07498b0cc220357b939d166703"
        },
        {
          "path": "server/servers/game/role/role_mgr.go",
          "symbol": "updateRoleInfo",
          "startLine": 66,
          "endLine": 68,
          "digest": "61e96ebe4fa28905a529f159ad24a79932abacac2861cd1a6460a29628584c6c"
        }
      ]
    },
    {
      "id": "equip-effect",
      "sceneId": "equip",
      "title": "下次生成时读取共享等级效果",
      "kind": "result",
      "summary": "只处理当前上阵技能；卸下后无通灵效果。",
      "detail": "功能关闭、无养成状态、上阵 ID 无效或等级效果行缺失时，跳过通灵效果。否则按“上阵技能 S + 当前总等级 L”查行：battleSkillId 为正时加入战斗技能，追加该行 Buff；不读取旧 attrs。缺少效果行不会回退本次上阵操作。",
      "input": "上阵 S 或 0；当前总等级 L；技能等级效果表",
      "output": "有效效果 → 战斗技能与 Buff；卸下或缺行 → 不追加通灵效果",
      "position": {
        "x": 0,
        "y": 1080
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "calcRolePsychoSkillAtt",
          "startLine": 114,
          "endLine": 134,
          "digest": "0417074c00df782af46c407632c716c22f8d17031de23b24b62198a75bf3562b"
        },
        {
          "path": "server/entry/extends/psycho_skill.go",
          "symbol": "GetPsychoSkillLevel",
          "startLine": 6,
          "endLine": 12,
          "digest": "e8cac60890a61d6b726966265c8cdc1f57475e5b8f6663ad57bb7bd9296c4b1f"
        },
        {
          "path": "server/servers/game/role/role_mgr.go",
          "symbol": "GetRoleInfo",
          "startLine": 32,
          "endLine": 38,
          "digest": "35ad8d74368ea0f51711d14814d0c50773dbb8bbcbc84178274a25d9ff7f4661"
        },
        {
          "path": "server/servers/game/role/role.go",
          "symbol": "calcRoleAtt",
          "startLine": 926,
          "endLine": 927,
          "digest": "475f242c201caca6e82967eabd8b7d10811ad0aa129de1392a13e70d396e2128"
        }
      ]
    },
    {
      "id": "equip-rejected",
      "sceneId": "equip",
      "title": "拒绝变更，保留原上阵",
      "kind": "failure",
      "summary": "不扣费，也不改变已有选择。",
      "detail": "功能关闭，或者非 0 目标的 ID、配置、职业或解锁资格无效时拒绝。此失败发生在保存新选择与清除缓存之前。",
      "input": "上阵校验失败",
      "output": "等级 L；解锁 U；上阵仍为 E；资源保持",
      "position": {
        "x": 360,
        "y": 400
      },
      "evidence": [
        {
          "path": "server/servers/game/role/psycho_skill.go",
          "symbol": "ValidatePsychoSkillLineUp / PsychoSkillLineUp",
          "startLine": 50,
          "endLine": 74,
          "digest": "ba5633a2984a68b1815bb9c474e1b8e7c728b1a06f5d6d3d9dd261b5badb61ff"
        }
      ]
    }
  ],
  "edges": [
    {
      "id": "upgrade-start-to-toggle",
      "sceneId": "upgrade",
      "source": "upgrade-start",
      "target": "upgrade-toggle",
      "label": "提交",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "upgrade-toggle-to-level",
      "sceneId": "upgrade",
      "source": "upgrade-toggle",
      "target": "upgrade-level",
      "label": "开放",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "upgrade-level-to-cost",
      "sceneId": "upgrade",
      "source": "upgrade-level",
      "target": "upgrade-cost",
      "label": "未满级且配置齐全",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "upgrade-cost-to-apply",
      "sceneId": "upgrade",
      "source": "upgrade-cost",
      "target": "upgrade-apply",
      "label": "条件与资源满足",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "upgrade-apply-to-refresh",
      "sceneId": "upgrade",
      "source": "upgrade-apply",
      "target": "upgrade-refresh",
      "label": "完成扣费与升级",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "upgrade-refresh-to-complete",
      "sceneId": "upgrade",
      "source": "upgrade-refresh",
      "target": "upgrade-complete",
      "label": "返回成功",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "unlock-start-to-eligible",
      "sceneId": "unlock",
      "source": "unlock-start",
      "target": "unlock-eligible",
      "label": "提交",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "unlock-eligible-to-duplicate",
      "sceneId": "unlock",
      "source": "unlock-eligible",
      "target": "unlock-duplicate",
      "label": "功能、技能、职业有效",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "unlock-duplicate-to-cost",
      "sceneId": "unlock",
      "source": "unlock-duplicate",
      "target": "unlock-cost",
      "label": "尚未解锁",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "unlock-cost-to-apply",
      "sceneId": "unlock",
      "source": "unlock-cost",
      "target": "unlock-apply",
      "label": "条件与资源满足",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "unlock-apply-to-update",
      "sceneId": "unlock",
      "source": "unlock-apply",
      "target": "unlock-update",
      "label": "记录成功",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "unlock-update-to-complete",
      "sceneId": "unlock",
      "source": "unlock-update",
      "target": "unlock-complete",
      "label": "返回成功",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "equip-start-to-toggle",
      "sceneId": "equip",
      "source": "equip-start",
      "target": "equip-toggle",
      "label": "提交",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "equip-toggle-to-route",
      "sceneId": "equip",
      "source": "equip-toggle",
      "target": "equip-route",
      "label": "开放",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "equip-route-to-eligible",
      "sceneId": "equip",
      "source": "equip-route",
      "target": "equip-eligible",
      "label": "非 0：上阵技能",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "equip-eligible-to-apply",
      "sceneId": "equip",
      "source": "equip-eligible",
      "target": "equip-apply",
      "label": "已解锁且符合职业",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "equip-apply-to-refresh",
      "sceneId": "equip",
      "source": "equip-apply",
      "target": "equip-refresh",
      "label": "选择已保存",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "equip-refresh-to-effect",
      "sceneId": "equip",
      "source": "equip-refresh",
      "target": "equip-effect",
      "label": "下次读取属性",
      "detail": "按图示条件或执行顺序进入下一步骤。"
    },
    {
      "id": "upgrade-toggle-to-rejected",
      "sceneId": "upgrade",
      "source": "upgrade-toggle",
      "target": "upgrade-rejected",
      "label": "功能关闭",
      "detail": "校验失败即返回；不执行后续变更步骤。"
    },
    {
      "id": "upgrade-level-to-rejected",
      "sceneId": "upgrade",
      "source": "upgrade-level",
      "target": "upgrade-rejected",
      "label": "满级或配置缺失",
      "detail": "校验失败即返回；不执行后续变更步骤。"
    },
    {
      "id": "upgrade-cost-to-rejected",
      "sceneId": "upgrade",
      "source": "upgrade-cost",
      "target": "upgrade-rejected",
      "label": "条件或资源不足",
      "detail": "校验失败即返回；不执行后续变更步骤。"
    },
    {
      "id": "unlock-eligible-to-rejected",
      "sceneId": "unlock",
      "source": "unlock-eligible",
      "target": "unlock-rejected",
      "label": "功能、技能或职业无效",
      "detail": "校验失败即返回；不执行后续变更步骤。"
    },
    {
      "id": "unlock-duplicate-to-rejected",
      "sceneId": "unlock",
      "source": "unlock-duplicate",
      "target": "unlock-rejected",
      "label": "已经解锁",
      "detail": "校验失败即返回；不执行后续变更步骤。"
    },
    {
      "id": "unlock-cost-to-rejected",
      "sceneId": "unlock",
      "source": "unlock-cost",
      "target": "unlock-rejected",
      "label": "条件或资源不足",
      "detail": "校验失败即返回；不执行后续变更步骤。"
    },
    {
      "id": "equip-toggle-to-rejected",
      "sceneId": "equip",
      "source": "equip-toggle",
      "target": "equip-rejected",
      "label": "功能关闭",
      "detail": "校验失败即返回；不执行后续变更步骤。"
    },
    {
      "id": "equip-eligible-to-rejected",
      "sceneId": "equip",
      "source": "equip-eligible",
      "target": "equip-rejected",
      "label": "配置、职业或资格无效",
      "detail": "校验失败即返回；不执行后续变更步骤。"
    },
    {
      "id": "equip-route-to-apply",
      "sceneId": "equip",
      "source": "equip-route",
      "target": "equip-apply",
      "label": "0：直接卸下",
      "detail": "功能开放时，卸下直接通过资格校验，不检查技能配置与解锁集合。"
    }
  ],
  "comments": []
}
