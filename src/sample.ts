import type { ReviewDocument } from './types.ts'

// Fictional rules authored in examples/subscription.md; regenerate digests when those rules change.
export const sampleReview: ReviewDocument = {
  "schemaVersion": 1,
  "id": "demo-subscription-v1",
  "title": "虚构演示 · 订阅工作区",
  "description": "三个独立场景演示套餐升级、集成启用和通知设置；所有规则与点数均为虚构，不接入真实支付或消息服务。",
  "revision": "synthetic-v1",
  "snapshot": {
    "repository": "LogicMargin fictional examples",
    "commit": "synthetic-v1 (not a Git commit)",
    "fingerprint": "37ee5c15d2036bd7ff1e0ac2640c5e646edd036f2c44c219d6a4ee0e7492d83c",
    "capturedAt": "2026-11-10T00:00:00Z",
    "dirty": false,
    "files": [
      {
        "path": "examples/subscription.md",
        "sha256": "a8560c10b4e48c0e8fbaef8f61f00c0e0d50e86b94b1d92158de8ca1ec41c2e4"
      }
    ]
  },
  "coverage": {
    "included": [
      "升级订阅套餐",
      "启用演示集成",
      "选择通知渠道"
    ],
    "excluded": [
      "真实账号、支付、外部服务和生产存储",
      "并发、事务、部署与线上运行验收"
    ],
    "note": "全部内容为仓库原创的虚构演示，依据是 examples 中的规则文档，不来自业务工程或真实源码快照。稳定图形 ID 仅供交互测试；文档 ID 独立，不迁移其他评审的批注或草稿。"
  },
  "scenes": [
    {
      "id": "upgrade",
      "title": "升级订阅套餐",
      "description": "使用演示点数升级套餐，保留集成和通知设置。"
    },
    {
      "id": "unlock",
      "title": "启用演示集成",
      "description": "检查套餐支持和点数，启用一个虚构集成。"
    },
    {
      "id": "equip",
      "title": "选择通知渠道",
      "description": "保存渠道或暂停状态，只展示预览。"
    }
  ],
  "nodes": [
    {
      "id": "upgrade-start",
      "sceneId": "upgrade",
      "title": "发起套餐升级",
      "kind": "action",
      "summary": "为虚构工作区申请更高套餐。",
      "detail": "演示请求只携带目标套餐名称，尚不写入任何设置。",
      "input": "工作区、当前套餐、目标套餐",
      "output": "进入服务可用性检查",
      "position": {
        "x": 0,
        "y": 0
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "upgrade-start",
          "startLine": 7,
          "endLine": 12,
          "digest": "5cf33c48b58df41131700035d2a3637737d3718d26bb7ff441489d96f0dbee23"
        }
      ]
    },
    {
      "id": "upgrade-toggle",
      "sceneId": "upgrade",
      "title": "订阅服务是否可用？",
      "kind": "decision",
      "summary": "维护期间拒绝新升级。",
      "detail": "此虚构规则要求订阅服务可用后才读取套餐目录；不可用时保留工作区原设置。",
      "input": "服务状态",
      "output": "可用时继续，否则拒绝",
      "position": {
        "x": 0,
        "y": 180
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "upgrade-toggle",
          "startLine": 14,
          "endLine": 19,
          "digest": "c81ab150f2bba83dc7fed4213842d1886655818bb252b2ffd57afc42e99c5f9d"
        }
      ]
    },
    {
      "id": "upgrade-level",
      "sceneId": "upgrade",
      "title": "目标套餐可以升级吗？",
      "kind": "decision",
      "summary": "仅允许目录中更高的套餐。",
      "detail": "当前套餐与目标套餐都必须在演示目录中，目标排序必须更高；不处理降级或续期。",
      "input": "当前套餐、目标套餐、演示目录",
      "output": "合法升级或拒绝",
      "position": {
        "x": 0,
        "y": 360
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "upgrade-level",
          "startLine": 21,
          "endLine": 26,
          "digest": "792e9e997f5b04095b7f9c8a392777c72f44502e0043c13e972cdf059c4d788a"
        }
      ]
    },
    {
      "id": "upgrade-cost",
      "sceneId": "upgrade",
      "title": "演示额度是否足够？",
      "kind": "decision",
      "summary": "使用虚构点数演示校验。",
      "detail": "先比较演示余额与目录中的升级点数。点数没有货币价值，也不接入任何支付服务。",
      "input": "演示余额、升级点数",
      "output": "足够时继续，否则拒绝",
      "position": {
        "x": 0,
        "y": 540
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "upgrade-cost",
          "startLine": 28,
          "endLine": 33,
          "digest": "27c3516235c0f4f90f164a1b67a4cefbe72d0a012c580338aa9cbf349f75a9c6"
        }
      ]
    },
    {
      "id": "upgrade-apply",
      "sceneId": "upgrade",
      "title": "扣除点数并保存套餐",
      "kind": "action",
      "summary": "确认后只改变套餐与演示余额。",
      "detail": "在本演示的单步状态模型中，保存目标套餐并扣除对应点数；集成集合和通知渠道保持原值。",
      "input": "合法目标套餐、足够点数",
      "output": "新套餐、更新后的演示余额",
      "position": {
        "x": 0,
        "y": 720
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "upgrade-apply",
          "startLine": 35,
          "endLine": 40,
          "digest": "935d638ec84dc681d3b7b9a2f1ff8371035016f2662ba0765081e27e5be0f70b"
        }
      ]
    },
    {
      "id": "upgrade-refresh",
      "sceneId": "upgrade",
      "title": "刷新套餐展示",
      "kind": "action",
      "summary": "更新页面使用的套餐摘要。",
      "detail": "记录一次展示刷新事件，供演示图说明成功路径；没有真实缓存或外部通知。",
      "input": "已保存的套餐",
      "output": "新的展示摘要",
      "position": {
        "x": 0,
        "y": 900
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "upgrade-refresh",
          "startLine": 42,
          "endLine": 47,
          "digest": "3fe16e0ef9ae89bad588ed5df520cf73f8a7d04876aded91d05d44182b1d3d21"
        }
      ]
    },
    {
      "id": "upgrade-complete",
      "sceneId": "upgrade",
      "title": "套餐升级完成",
      "kind": "result",
      "summary": "集成与通知渠道保持原设置。",
      "detail": "显示新套餐名称和剩余演示点数，本场景到此结束。",
      "input": "新套餐、演示余额",
      "output": "升级成功结果",
      "position": {
        "x": 0,
        "y": 1080
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "upgrade-complete",
          "startLine": 49,
          "endLine": 54,
          "digest": "642d20f7635693f51aed000c1b26363f0a25b3df4bbb62dee5281b9580879fc2"
        }
      ]
    },
    {
      "id": "upgrade-rejected",
      "sceneId": "upgrade",
      "title": "拒绝升级，保留设置",
      "kind": "failure",
      "summary": "失败校验不会消耗演示点数。",
      "detail": "服务不可用、套餐无效或点数不足时返回对应原因，不改变套餐、集成或通知设置。",
      "input": "校验失败原因",
      "output": "原设置与原余额",
      "position": {
        "x": 360,
        "y": 400
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "upgrade-rejected",
          "startLine": 56,
          "endLine": 61,
          "digest": "073a7338ffc8760d1be7271dc5c297bc5d61b16b9b2e49d1bf58cb1ef4f37681"
        }
      ]
    },
    {
      "id": "unlock-start",
      "sceneId": "unlock",
      "title": "选择要启用的集成",
      "kind": "action",
      "summary": "集成是独立于套餐的演示配置。",
      "detail": "请求选择一个演示集成，例如日历导出；没有真实账号或外部授权。",
      "input": "工作区、集成键",
      "output": "进入集成资格检查",
      "position": {
        "x": 0,
        "y": 0
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "unlock-start",
          "startLine": 63,
          "endLine": 68,
          "digest": "2341f14ef3d4421dafcc38082b32ec54aed72f67eb06d9e262e8e1d2064d6ade"
        }
      ]
    },
    {
      "id": "unlock-eligible",
      "sceneId": "unlock",
      "title": "服务与集成是否有效？",
      "kind": "decision",
      "summary": "仅允许目录中的集成。",
      "detail": "服务必须可用，集成键必须存在，且当前套餐需要支持该集成。",
      "input": "服务状态、集成目录、套餐",
      "output": "有效时继续，否则拒绝",
      "position": {
        "x": 0,
        "y": 180
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "unlock-eligible",
          "startLine": 70,
          "endLine": 75,
          "digest": "baa6cff5b17744230174d99ee61e817ee0111b228923f8c049b5fceed68847a2"
        }
      ]
    },
    {
      "id": "unlock-duplicate",
      "sceneId": "unlock",
      "title": "集成是否尚未启用？",
      "kind": "decision",
      "summary": "重复请求不能重复扣点。",
      "detail": "检查工作区启用集合中是否已包含此集成；已有则拒绝本次重复操作。",
      "input": "集成键、启用集合",
      "output": "首次启用或拒绝",
      "position": {
        "x": 0,
        "y": 360
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "unlock-duplicate",
          "startLine": 77,
          "endLine": 82,
          "digest": "1c8586d82b8d94b0785f60d18cab58a950163d8f7e79512e75eea651e1d3f9db"
        }
      ]
    },
    {
      "id": "unlock-cost",
      "sceneId": "unlock",
      "title": "启用额度是否足够？",
      "kind": "decision",
      "summary": "先检查集成所需演示点数。",
      "detail": "目录提供一次启用点数，余额不足时不改变启用集合。",
      "input": "演示余额、启用点数",
      "output": "足够时继续，否则拒绝",
      "position": {
        "x": 0,
        "y": 540
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "unlock-cost",
          "startLine": 84,
          "endLine": 89,
          "digest": "9ce78206f518209fa35953dbdc2430cd06d885b483f79896d46ef0b8ab6ddee1"
        }
      ]
    },
    {
      "id": "unlock-apply",
      "sceneId": "unlock",
      "title": "扣除点数并启用集成",
      "kind": "action",
      "summary": "只新增一项集成。",
      "detail": "本演示在一个状态步骤中扣除点数并将集成键加入集合，不改变套餐与通知渠道。",
      "input": "集成键、足够点数",
      "output": "更新后的启用集合与余额",
      "position": {
        "x": 0,
        "y": 720
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "unlock-apply",
          "startLine": 91,
          "endLine": 96,
          "digest": "2b501ad30a3d704a3c7e27cad859e6c64b30d155cff2e2cc991a8a95e313e717"
        }
      ]
    },
    {
      "id": "unlock-update",
      "sceneId": "unlock",
      "title": "记录集成设置",
      "kind": "action",
      "summary": "保留当前通知渠道。",
      "detail": "记录集成已启用的演示事件，套餐和通知选择继续使用原值。",
      "input": "新的启用集合",
      "output": "集成摘要更新",
      "position": {
        "x": 0,
        "y": 900
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "unlock-update",
          "startLine": 98,
          "endLine": 103,
          "digest": "e095ca2cba77cfc668fdeaed8fe29f3851b36a66370ddc1cb22024aef4824386"
        }
      ]
    },
    {
      "id": "unlock-complete",
      "sceneId": "unlock",
      "title": "集成启用完成",
      "kind": "result",
      "summary": "套餐无需随集成变化。",
      "detail": "结果只报告新增集成与剩余演示点数，不执行外部服务调用。",
      "input": "新增集成",
      "output": "启用成功结果",
      "position": {
        "x": 0,
        "y": 1080
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "unlock-complete",
          "startLine": 105,
          "endLine": 110,
          "digest": "58dbaf915dea2e739701636d678b2a1b4bd7fd4e50c7ff3bccdf819db9fb2efa"
        }
      ]
    },
    {
      "id": "unlock-rejected",
      "sceneId": "unlock",
      "title": "拒绝启用，保留设置",
      "kind": "failure",
      "summary": "本次请求不扣点。",
      "detail": "服务、目录、套餐、重复请求或点数校验失败时，保留全部工作区设置和余额。",
      "input": "校验失败原因",
      "output": "原设置与原余额",
      "position": {
        "x": 360,
        "y": 400
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "unlock-rejected",
          "startLine": 112,
          "endLine": 117,
          "digest": "398b8e859c16176a1cccf0a30253bf72cfc64a6146b18c36e4d89784de1695df"
        }
      ]
    },
    {
      "id": "equip-start",
      "sceneId": "equip",
      "title": "选择通知渠道或暂停",
      "kind": "action",
      "summary": "通知设置独立于套餐变更。",
      "detail": "选择演示邮件、站内消息或暂停通知；界面不会实际发送消息。",
      "input": "工作区、渠道选择",
      "output": "进入通知服务检查",
      "position": {
        "x": 0,
        "y": 0
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "equip-start",
          "startLine": 119,
          "endLine": 124,
          "digest": "798b6222355427b1fd6aee580ffa2693c38a2d990cb4d0d6a1bbc42b20e52a6d"
        }
      ]
    },
    {
      "id": "equip-toggle",
      "sceneId": "equip",
      "title": "通知服务是否可用？",
      "kind": "decision",
      "summary": "服务不可用时拒绝修改。",
      "detail": "演示要求通知服务可用后才允许选择渠道或暂停通知。",
      "input": "通知服务状态",
      "output": "可用时继续，否则拒绝",
      "position": {
        "x": 0,
        "y": 180
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "equip-toggle",
          "startLine": 126,
          "endLine": 131,
          "digest": "18047a1df4eb6ee49aaedfc52ba89400fdd8877644c02c06292fb844eef8ce9f"
        }
      ]
    },
    {
      "id": "equip-route",
      "sceneId": "equip",
      "title": "是否选择暂停通知？",
      "kind": "decision",
      "summary": "暂停不需要查询渠道目录。",
      "detail": "选择暂停时直接进入保存步骤；选择具体渠道时继续校验目录与权限。",
      "input": "渠道选择",
      "output": "暂停分支或渠道检查",
      "position": {
        "x": 0,
        "y": 360
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "equip-route",
          "startLine": 133,
          "endLine": 138,
          "digest": "8af182ad1b26a1458a68e60498a40a9d1f530f6a78ae54173387f29cf228c0ba"
        }
      ]
    },
    {
      "id": "equip-eligible",
      "sceneId": "equip",
      "title": "渠道是否可用且获准？",
      "kind": "decision",
      "summary": "具体渠道必须在演示白名单中。",
      "detail": "渠道存在、已启用且受当前套餐支持时才允许保存；不读取真实收件地址。",
      "input": "渠道目录、套餐",
      "output": "可用时继续，否则拒绝",
      "position": {
        "x": 0,
        "y": 540
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "equip-eligible",
          "startLine": 140,
          "endLine": 145,
          "digest": "de98e71981d9a6cdf1ef6c0c35d83608471cbe57ad29b409ee81fd002ce2699b"
        }
      ]
    },
    {
      "id": "equip-apply",
      "sceneId": "equip",
      "title": "保存通知选择",
      "kind": "action",
      "summary": "只保存一个渠道或暂停状态。",
      "detail": "用所选渠道覆盖演示通知设置，不改变套餐、集成集合或余额。",
      "input": "合法渠道或暂停",
      "output": "新的通知设置",
      "position": {
        "x": 0,
        "y": 720
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "equip-apply",
          "startLine": 147,
          "endLine": 152,
          "digest": "6edac565c3cd3b4064cbaa13bf005bad7923c7660df09d8fb57aefbb0445412a"
        }
      ]
    },
    {
      "id": "equip-refresh",
      "sceneId": "equip",
      "title": "刷新通知预览",
      "kind": "action",
      "summary": "展示更新后的通知状态。",
      "detail": "生成只在页面阅读的预览描述，不发送邮件、不请求外部服务。",
      "input": "新的通知设置",
      "output": "通知预览",
      "position": {
        "x": 0,
        "y": 900
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "equip-refresh",
          "startLine": 154,
          "endLine": 159,
          "digest": "3d4c972722d12fb43a82ab09f93ca95bb9cf970155f30575f5e178238c630112"
        }
      ]
    },
    {
      "id": "equip-effect",
      "sceneId": "equip",
      "title": "显示通知预览",
      "kind": "result",
      "summary": "预览使用当前保存的选择。",
      "detail": "暂停显示无通知，具体渠道显示对应演示标签，本流程没有消息投递承诺。",
      "input": "保存的渠道或暂停",
      "output": "页面预览结果",
      "position": {
        "x": 0,
        "y": 1080
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "equip-effect",
          "startLine": 161,
          "endLine": 166,
          "digest": "fc295b4bed7cf388846c4fa8b0290b8e5e7a215b1fd136d1ea025d7423ffa0ff"
        }
      ]
    },
    {
      "id": "equip-rejected",
      "sceneId": "equip",
      "title": "拒绝修改，保留渠道",
      "kind": "failure",
      "summary": "错误不会覆盖已有选择。",
      "detail": "服务不可用或具体渠道未获准时返回原因，保留原通知设置、套餐与集成集合。",
      "input": "校验失败原因",
      "output": "原通知设置",
      "position": {
        "x": 360,
        "y": 400
      },
      "evidence": [
        {
          "path": "examples/subscription.md",
          "symbol": "equip-rejected",
          "startLine": 168,
          "endLine": 173,
          "digest": "0b018f00b8f984c0484d26800b66db0f5833ead42dd0bfcc5bdfe0c29ab57503"
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
      "detail": "虚构演示规则：提交时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "upgrade-toggle-to-level",
      "sceneId": "upgrade",
      "source": "upgrade-toggle",
      "target": "upgrade-level",
      "label": "服务可用",
      "detail": "虚构演示规则：服务可用时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "upgrade-level-to-cost",
      "sceneId": "upgrade",
      "source": "upgrade-level",
      "target": "upgrade-cost",
      "label": "可升级",
      "detail": "虚构演示规则：可升级时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "upgrade-cost-to-apply",
      "sceneId": "upgrade",
      "source": "upgrade-cost",
      "target": "upgrade-apply",
      "label": "额度足够",
      "detail": "虚构演示规则：额度足够时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "upgrade-apply-to-refresh",
      "sceneId": "upgrade",
      "source": "upgrade-apply",
      "target": "upgrade-refresh",
      "label": "套餐已保存",
      "detail": "虚构演示规则：套餐已保存时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "upgrade-refresh-to-complete",
      "sceneId": "upgrade",
      "source": "upgrade-refresh",
      "target": "upgrade-complete",
      "label": "展示已刷新",
      "detail": "虚构演示规则：展示已刷新时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-start-to-eligible",
      "sceneId": "unlock",
      "source": "unlock-start",
      "target": "unlock-eligible",
      "label": "提交",
      "detail": "虚构演示规则：提交时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-eligible-to-duplicate",
      "sceneId": "unlock",
      "source": "unlock-eligible",
      "target": "unlock-duplicate",
      "label": "服务与集成有效",
      "detail": "虚构演示规则：服务与集成有效时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-duplicate-to-cost",
      "sceneId": "unlock",
      "source": "unlock-duplicate",
      "target": "unlock-cost",
      "label": "尚未启用",
      "detail": "虚构演示规则：尚未启用时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-cost-to-apply",
      "sceneId": "unlock",
      "source": "unlock-cost",
      "target": "unlock-apply",
      "label": "额度足够",
      "detail": "虚构演示规则：额度足够时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-apply-to-update",
      "sceneId": "unlock",
      "source": "unlock-apply",
      "target": "unlock-update",
      "label": "集成已保存",
      "detail": "虚构演示规则：集成已保存时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-update-to-complete",
      "sceneId": "unlock",
      "source": "unlock-update",
      "target": "unlock-complete",
      "label": "记录完成",
      "detail": "虚构演示规则：记录完成时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-start-to-toggle",
      "sceneId": "equip",
      "source": "equip-start",
      "target": "equip-toggle",
      "label": "提交",
      "detail": "虚构演示规则：提交时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-toggle-to-route",
      "sceneId": "equip",
      "source": "equip-toggle",
      "target": "equip-route",
      "label": "服务可用",
      "detail": "虚构演示规则：服务可用时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-route-to-eligible",
      "sceneId": "equip",
      "source": "equip-route",
      "target": "equip-eligible",
      "label": "选择具体渠道",
      "detail": "虚构演示规则：选择具体渠道时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-eligible-to-apply",
      "sceneId": "equip",
      "source": "equip-eligible",
      "target": "equip-apply",
      "label": "渠道可用且获准",
      "detail": "虚构演示规则：渠道可用且获准时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-apply-to-refresh",
      "sceneId": "equip",
      "source": "equip-apply",
      "target": "equip-refresh",
      "label": "选择已保存",
      "detail": "虚构演示规则：选择已保存时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-refresh-to-effect",
      "sceneId": "equip",
      "source": "equip-refresh",
      "target": "equip-effect",
      "label": "生成预览",
      "detail": "虚构演示规则：生成预览时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "upgrade-toggle-to-rejected",
      "sceneId": "upgrade",
      "source": "upgrade-toggle",
      "target": "upgrade-rejected",
      "label": "服务不可用",
      "detail": "虚构演示规则：服务不可用时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "upgrade-level-to-rejected",
      "sceneId": "upgrade",
      "source": "upgrade-level",
      "target": "upgrade-rejected",
      "label": "套餐无效",
      "detail": "虚构演示规则：套餐无效时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "upgrade-cost-to-rejected",
      "sceneId": "upgrade",
      "source": "upgrade-cost",
      "target": "upgrade-rejected",
      "label": "额度不足",
      "detail": "虚构演示规则：额度不足时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-eligible-to-rejected",
      "sceneId": "unlock",
      "source": "unlock-eligible",
      "target": "unlock-rejected",
      "label": "服务或集成无效",
      "detail": "虚构演示规则：服务或集成无效时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-duplicate-to-rejected",
      "sceneId": "unlock",
      "source": "unlock-duplicate",
      "target": "unlock-rejected",
      "label": "已经启用",
      "detail": "虚构演示规则：已经启用时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "unlock-cost-to-rejected",
      "sceneId": "unlock",
      "source": "unlock-cost",
      "target": "unlock-rejected",
      "label": "额度不足",
      "detail": "虚构演示规则：额度不足时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-toggle-to-rejected",
      "sceneId": "equip",
      "source": "equip-toggle",
      "target": "equip-rejected",
      "label": "服务不可用",
      "detail": "虚构演示规则：服务不可用时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-eligible-to-rejected",
      "sceneId": "equip",
      "source": "equip-eligible",
      "target": "equip-rejected",
      "label": "渠道不可用",
      "detail": "虚构演示规则：渠道不可用时沿此分支继续；具体状态变化见目标步骤。"
    },
    {
      "id": "equip-route-to-apply",
      "sceneId": "equip",
      "source": "equip-route",
      "target": "equip-apply",
      "label": "选择暂停",
      "detail": "虚构演示规则：选择暂停时沿此分支继续；具体状态变化见目标步骤。"
    }
  ],
  "comments": []
}
