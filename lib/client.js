/**
 * dsh-workflow-orchestrator — browser half.
 *
 * Loaded through the DSH client module loader (`window.__ModuleLoader__`); the
 * factory receives the module table's `require`, so `react` resolves to the
 * shell's own copy and this file bundles no framework.
 *
 * The panel is a first-level page: it registers one `main` keyed slot occupant
 * plus a left-sidebar entry. Its three columns mirror the requested design —
 * node palette, workflow canvas, node inspector — with the execution log below.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workflow-orchestrator',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ---------------------------------------------------------------------
    // constants
    // ---------------------------------------------------------------------
    const PANEL_KEY = 'workflow-orchestrator'
    const API_ROOT = 'workflow-orchestrator/api'
    const STYLE_ID = 'dsh-workflow-orchestrator-style'
    const NODE_WIDTH = 214
    const TASK_HEIGHT = 136
    const GATEWAY_HEIGHT = 86
    const TASK_DRAG_TYPE = 'application/x-dsh-workflow-node'
    // Default canvas colors for workspaces, in first-appearance order.
    const WORKSPACE_PALETTE = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#ca8a04', '#dc2626']

    const NODE_STATUS_LABEL = {
      pending: '等待中',
      running: '运行中',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      skipped: '已跳过',
      'not-run': '未执行',
    }
    const RUN_STATUS_LABEL = {
      running: '运行中',
      completed: '已完成',
      failed: '失败',
      cancelled: '已停止',
    }
    const CONTEXT_MODE_OPTIONS = [
      {
        value: 'full',
        label: '带上游任务输出（默认）',
        hint: '把上游任务的最终回复正文附在提示词后面。',
      },
      {
        value: 'summary',
        label: '带上游任务会话摘要',
        hint: '只附上游任务的会话 ID 和一段摘要，节省上下文。',
      },
      { value: 'none', label: '完全不传', hint: '只发送本节点自己的提示词。' },
    ]
    const ON_INVALID_OPTIONS = [
      { value: 'continue', label: '继续（默认）', hint: '模型没有按格式输出判定时，按继续处理。' },
      { value: 'stop', label: '终止工作流', hint: '模型没有按格式输出判定时，按终止处理。' },
    ]
    const STOP_POLICY_OPTIONS = [
      {
        value: 'detach',
        label: '让在途任务继续跑完（默认）',
        hint: '只停止后续编排，已经在运行的任务会话继续执行完成。',
      },
      {
        value: 'cancel-tasks',
        label: '同时终止在途任务会话',
        hint: '立即请求取消所有正在运行的任务会话，尽快结束本次运行。',
      },
    ]

    // ---------------------------------------------------------------------
    // styles
    // ---------------------------------------------------------------------
    const CSS = `
.wfo-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
[data-platform="darwin"] .wfo-toolbar{padding-top:calc(8px + var(--dsh-frame-top-clearance,0px))}
.wfo-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#e6e8eb);background:var(--dsw-alias-bg-layer-1,#fafbfc)}
.wfo-brand{display:flex;align-items:center;gap:6px;font-weight:600;white-space:nowrap;margin-right:2px}
.wfo-brand-mark{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-accent,#4d6bfe) 14%,transparent);color:var(--dsw-alias-accent,#4d6bfe)}
.wfo-toolbar .wfo-grow{flex:1 1 auto}
.wfo-select,.wfo-input,.wfo-textarea{box-sizing:border-box;font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#d8dbe0);border-radius:7px;padding:5px 8px;outline:none;transition:border-color .15s,box-shadow .15s;max-width:100%}
.wfo-select:focus,.wfo-input:focus,.wfo-textarea:focus{border-color:var(--dsw-alias-accent,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-accent,#4d6bfe) 16%,transparent)}
.wfo-input.name{width:180px;font-weight:500}
.wfo-toolbar .wfo-select{max-width:210px}
.wfo-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#d8dbe0);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12.5px;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s}
.wfo-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f1f2f4)}
.wfo-btn:disabled{opacity:.45;cursor:not-allowed}
.wfo-btn.primary{background:var(--dsw-alias-accent,#4d6bfe);border-color:transparent;color:#fff;font-weight:500}
.wfo-btn.primary:hover:not(:disabled){background:var(--dsw-alias-accent,#4d6bfe);border-color:transparent;color:#fff;filter:brightness(1.08)}
.wfo-btn.danger{color:var(--dsw-alias-state-error-primary,#d1453b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1453b) 40%,transparent)}
.wfo-btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1453b) 8%,transparent)}
.wfo-btn.ghost{border-color:transparent;background:transparent}
.wfo-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f1f2f4)}
.wfo-btn.small{height:24px;padding:0 8px;font-size:12px}
.wfo-save-state{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9099);white-space:nowrap}
.wfo-main{flex:1 1 auto;display:grid;grid-template-columns:190px minmax(0,1fr) 340px;min-height:0}
.wfo-center{display:flex;flex-direction:column;min-width:0;min-height:0}
.wfo-palette{min-height:0;overflow:auto;padding:10px;border-right:1px solid var(--dsw-alias-border-l2,#e6e8eb);background:var(--dsw-alias-bg-layer-1,#fafbfc)}
.wfo-palette-title{font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a9099);margin:2px 0 8px}
.wfo-pal-item{display:flex;flex-direction:column;gap:4px;padding:9px 10px;margin-bottom:8px;border:1px dashed var(--dsw-alias-border-l2,#cfd3d9);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);cursor:grab;transition:border-color .15s,box-shadow .15s,transform .1s}
.wfo-pal-item:hover{border-color:var(--dsw-alias-accent,#4d6bfe);box-shadow:0 2px 8px rgba(0,0,0,.06)}
.wfo-pal-item:active{cursor:grabbing;transform:scale(.99)}
.wfo-pal-head{display:flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px}
.wfo-pal-icon{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.wfo-pal-icon.task{background:color-mix(in srgb,var(--dsw-alias-accent,#4d6bfe) 14%,transparent);color:var(--dsw-alias-accent,#4d6bfe)}
.wfo-pal-icon.gw{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 16%,transparent);color:var(--dsw-alias-state-warn-primary,#d97706)}
.wfo-pal-icon.judge{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 15%,transparent);color:var(--dsw-alias-state-success-primary,#16a34a)}
.wfo-pal-icon.stop{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1453b) 13%,transparent);color:var(--dsw-alias-state-error-primary,#d1453b)}
.wfo-pal-desc{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9099);line-height:1.4}
.wfo-pal-foot{margin-top:12px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l2,#e6e8eb);font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099);line-height:1.5}
.wfo-canvas-wrap{position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:auto;background-color:var(--dsw-alias-bg-layer-2,#f5f6f8);background-image:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-label-tertiary,#8a9099) 28%,transparent) 1px,transparent 1px);background-size:18px 18px}
.wfo-canvas-inner{position:relative}
.wfo-inner-hint{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;color:var(--dsw-alias-label-tertiary,#8a9099);user-select:none}
.wfo-inner-hint b{display:block;font-size:14px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c6270);margin-bottom:6px}
.wfo-inner-hint span{font-size:12px}
.wfo-edges{position:absolute;inset:0;overflow:visible;pointer-events:none}
.wfo-edge{fill:none;stroke:var(--dsw-alias-border-l4,#b9bfc8);stroke-width:1.8;pointer-events:stroke;cursor:pointer;transition:stroke .15s}
.wfo-edge:hover{stroke:var(--dsw-alias-label-secondary,#5c6270)}
.wfo-edge.selected{stroke:var(--dsw-alias-accent,#4d6bfe);stroke-width:2.6}
.wfo-edge.temp{stroke:var(--dsw-alias-accent,#4d6bfe);stroke-width:2;stroke-dasharray:5 4;pointer-events:none}
.wfo-node{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:1.5px solid var(--dsw-alias-border-l2,#d8dbe0);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 3px rgba(15,23,42,.08);cursor:grab;user-select:none;transition:border-color .15s,box-shadow .15s;touch-action:none}
.wfo-node:hover{box-shadow:0 3px 10px rgba(15,23,42,.1)}
.wfo-node.selected{border-color:var(--dsw-alias-accent,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-accent,#4d6bfe) 18%,transparent),0 2px 8px rgba(15,23,42,.1)}
.wfo-node.is-running{border-color:var(--dsw-alias-state-business-primary,#2563eb);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 16%,transparent)}
.wfo-node.is-completed{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 60%,transparent)}
.wfo-node.is-failed{border-color:var(--dsw-alias-state-error-primary,#d1453b)}
.wfo-node.is-cancelled,.wfo-node.is-skipped{border-color:var(--dsw-alias-border-l2,#d8dbe0);opacity:.72}
.wfo-node.is-not-run{border-style:dashed;opacity:.55}
.wfo-node-head{display:flex;align-items:center;gap:6px;min-width:0}
.wfo-node-badge{flex:0 0 auto;font-size:10px;font-weight:600;line-height:16px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#eef0f3);color:var(--dsw-alias-label-secondary,#5c6270)}
.wfo-node-badge.gw{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 15%,transparent);color:var(--dsw-alias-state-warn-primary,#d97706)}
.wfo-node-badge.judge{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 14%,transparent);color:var(--dsw-alias-state-success-primary,#16a34a)}
.wfo-node-badge.stop{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1453b) 12%,transparent);color:var(--dsw-alias-state-error-primary,#d1453b)}
.wfo-node-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12.5px}
.wfo-node-status{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a9099);white-space:nowrap}
.wfo-node-status.running{color:var(--dsw-alias-state-business-primary,#2563eb)}
.wfo-node-status.failed{color:var(--dsw-alias-state-error-primary,#d1453b)}
.wfo-node-status.completed{color:var(--dsw-alias-state-success-primary,#16a34a)}
.wfo-node-status.not-run{color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.wfo-node-prompt{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#5c6270);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;min-height:0}
.wfo-node-prompt.empty{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-style:italic}
.wfo-node-meta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a9099);min-width:0}
.wfo-node-meta span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfo-node-workspace{display:flex;align-items:center;gap:5px;min-width:0;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary,#5c6270)}
.wfo-node-ws-dot{flex:0 0 auto;width:7px;height:7px;border-radius:2px;background:var(--dsw-alias-label-tertiary,#8a9099);box-shadow:0 0 0 1px color-mix(in srgb,#000 10%,transparent)}
.wfo-node-ws-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfo-node-ws-tag{flex:0 0 auto;font-size:9.5px;line-height:14px;padding:0 4px;border-radius:3px;color:var(--dsw-alias-label-tertiary,#9aa0a8);background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#8a9099) 12%,transparent)}
.wfo-node-workspace.empty{color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.wfo-node.gateway{flex-direction:row;align-items:center;gap:10px;padding:10px 12px}
.wfo-gw-diamond{flex:0 0 auto;width:34px;height:34px;margin-left:4px;border:2px solid var(--dsw-alias-state-warn-primary,#d97706);border-radius:7px;transform:rotate(45deg);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 8%,transparent)}
.wfo-gw-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.wfo-gw-text b{font-size:12.5px;font-weight:600}
.wfo-gw-text span{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a9099);white-space:nowrap}
.wfo-node.terminate{flex-direction:row;align-items:center;gap:10px;padding:10px 12px}
.wfo-terminate-icon{flex:0 0 auto;position:relative;width:30px;height:30px;margin-left:4px;border:2px solid var(--dsw-alias-state-error-primary,#d1453b);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1453b) 8%,transparent)}
.wfo-terminate-icon::before{content:"";position:absolute;inset:6px;border-radius:2px;background:var(--dsw-alias-state-error-primary,#d1453b)}
.wfo-port{position:absolute;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base,#fff);border:2px solid var(--dsw-alias-border-l4,#b9bfc8);box-shadow:0 0 0 2px var(--dsw-alias-bg-base,#fff);cursor:crosshair;z-index:4;transition:transform .12s,border-color .12s,background .12s}
.wfo-port::before{content:"";position:absolute;inset:-7px;border-radius:50%}
.wfo-port:hover{transform:scale(1.25);border-color:var(--dsw-alias-accent,#4d6bfe);background:var(--dsw-alias-accent,#4d6bfe)}
.wfo-port.in{left:-8px;top:calc(50% - 6px)}
.wfo-port.out{right:-8px;top:calc(50% - 6px);border-color:var(--dsw-alias-accent,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-accent,#4d6bfe) 18%,#fff)}
.wfo-inspector{min-height:0;overflow:auto;padding:12px;border-left:1px solid var(--dsw-alias-border-l2,#e6e8eb);background:var(--dsw-alias-bg-layer-1,#fafbfc);display:flex;flex-direction:column}
.wfo-field.prompt{display:flex;flex-direction:column;flex:1 1 auto;min-height:216px}
.wfo-field.prompt .wfo-textarea{flex:1 1 auto;min-height:216px}
.wfo-insp-head{display:flex;align-items:center;gap:8px;margin-bottom:12px;min-width:0}
.wfo-insp-head h3{font-size:13.5px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfo-insp-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099)}
.wfo-field{margin-bottom:12px}
.wfo-field>label{display:block;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c6270);margin-bottom:5px}
.wfo-field .wfo-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099);margin-top:4px;line-height:1.45}
.wfo-field .wfo-select,.wfo-field .wfo-input,.wfo-field .wfo-textarea{width:100%}
.wfo-textarea{min-height:168px;resize:vertical;line-height:1.55;font-size:12.5px}
.wfo-insp-empty{display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-secondary,#5c6270);font-size:12px}
.wfo-insp-empty .wfo-empty-card{border:1px dashed var(--dsw-alias-border-l2,#d0d4da);border-radius:9px;padding:10px;line-height:1.55;background:var(--dsw-alias-bg-base,#fff)}
.wfo-field .wfo-empty-card{border:1px dashed var(--dsw-alias-border-l2,#d0d4da);border-radius:9px;padding:10px;line-height:1.55;background:var(--dsw-alias-bg-base,#fff)}
.wfo-start-here{margin-bottom:12px}
.wfo-start-here .wfo-btn{width:100%;height:32px;font-size:13px}
.wfo-ws-colors{display:flex;flex-direction:column;gap:6px}
.wfo-ws-color-row{display:flex;align-items:center;gap:7px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5c6270)}
.wfo-ws-color-dot{flex:0 0 auto;width:12px;height:12px;border-radius:4px;box-shadow:0 0 0 1px color-mix(in srgb,#000 12%,transparent)}
.wfo-ws-color-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfo-ws-count{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099);white-space:nowrap}
.wfo-color-input{flex:0 0 auto;box-sizing:border-box;width:30px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2,#d8dbe0);border-radius:5px;background:var(--dsw-alias-bg-base,#fff);cursor:pointer}
.wfo-color-input::-webkit-color-swatch-wrapper{padding:2px}
.wfo-color-input::-webkit-color-swatch{border:none;border-radius:3px}
.wfo-run-card{border:1px solid var(--dsw-alias-border-l2,#e0e3e8);border-radius:9px;padding:9px 10px;background:var(--dsw-alias-bg-base,#fff);margin-bottom:12px;display:flex;flex-direction:column;gap:6px}
.wfo-run-row{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5c6270);min-width:0}
.wfo-run-row b{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.wfo-run-row code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2,#f2f4f6);border-radius:4px;padding:1px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.wfo-run-actions{display:flex;gap:6px;flex-wrap:wrap}
.wfo-divider{height:1px;background:var(--dsw-alias-border-l2,#e6e8eb);margin:12px 0}
.wfo-log{flex:0 0 176px;display:flex;flex-direction:column;min-height:0;border-top:1px solid var(--dsw-alias-border-l2,#e6e8eb);background:var(--dsw-alias-bg-layer-1,#fafbfc)}
.wfo-log-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#eceef1);font-size:12px;font-weight:600}
.wfo-log-head .wfo-grow{flex:1 1 auto}
.wfo-log-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 8px 8px;font-family:ui-monospace,SFMono-Regular,Consolas,"Cascadia Mono",monospace;font-size:11.5px;line-height:1.55}
.wfo-log-empty{padding:18px 6px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a9099);font-family:inherit;font-size:11.5px}
.wfo-log-row{display:flex;gap:7px;padding:2px 4px;border-radius:4px;align-items:flex-start}
.wfo-log-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f0f2f4)}
.wfo-log-time{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.wfo-log-level{flex:0 0 auto;font-weight:700;font-size:10px;line-height:16px;padding:0 4px;border-radius:3px;margin-top:1px}
.wfo-log-level.info{color:var(--dsw-alias-state-business-primary,#2563eb);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 12%,transparent)}
.wfo-log-level.warn{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 14%,transparent)}
.wfo-log-level.error{color:var(--dsw-alias-state-error-primary,#d1453b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1453b) 12%,transparent)}
.wfo-log-node{flex:0 0 auto;color:var(--dsw-alias-label-secondary,#5c6270);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfo-log-msg{flex:1 1 auto;min-width:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#1f2328)}
.wfo-pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:1;background:var(--dsw-alias-bg-layer-2,#eef0f3);color:var(--dsw-alias-label-secondary,#5c6270);white-space:nowrap}
.wfo-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.8}
.wfo-pill.running{color:var(--dsw-alias-state-business-primary,#2563eb);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 12%,transparent)}
.wfo-pill.running::before{animation:wfo-pulse 1.1s ease-in-out infinite}
.wfo-pill.completed{color:var(--dsw-alias-state-success-primary,#16a34a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 12%,transparent)}
.wfo-pill.failed{color:var(--dsw-alias-state-error-primary,#d1453b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1453b) 12%,transparent)}
.wfo-pill.cancelled{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 13%,transparent)}
.wfo-pill.terminated{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 13%,transparent)}
@keyframes wfo-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.wfo-banner{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l2,#e6e8eb)}
.wfo-banner.error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1453b) 9%,transparent);color:var(--dsw-alias-state-error-primary,#b3261e)}
.wfo-banner.info{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 8%,transparent);color:var(--dsw-alias-label-secondary,#475069)}
.wfo-banner.warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 9%,transparent);color:var(--dsw-alias-state-warn-primary,#b45309);border-bottom-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 26%,transparent)}
.wfo-banner .wfo-grow{flex:1 1 auto}
.wfo-modal-mask{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,#000 34%,transparent);padding:24px}
.wfo-modal{width:min(440px,92vw);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 18px 50px rgba(0,0,0,.24);padding:18px 18px 14px;display:flex;flex-direction:column;gap:10px}
.wfo-modal h3{margin:0;font-size:15px}
.wfo-modal p{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#5c6270);line-height:1.55}
.wfo-modal-option{display:flex;flex-direction:column;gap:8px}
.wfo-modal-btn{display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:left;padding:10px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#d8dbe0);background:var(--dsw-alias-bg-base,#fff);font:inherit;cursor:pointer;color:inherit}
.wfo-modal-btn:hover{border-color:var(--dsw-alias-accent,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-accent,#4d6bfe) 5%,transparent)}
.wfo-modal-btn b{font-size:13px}
.wfo-modal-btn span{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a9099)}
.wfo-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.wfo-loading{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-tertiary,#8a9099);font-size:13px;gap:8px}
.wfo-spinner{width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#8a9099) 30%,transparent);border-top-color:var(--dsw-alias-accent,#4d6bfe);animation:wfo-spin .8s linear infinite}
@keyframes wfo-spin{to{transform:rotate(360deg)}}
.wfo-kbd{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;border:1px solid var(--dsw-alias-border-l2,#d8dbe0);border-radius:4px;padding:0 4px;background:var(--dsw-alias-bg-layer-2,#f2f4f6)}
`

    /** Resolve the plugin's routes under the page's own mount prefix. */
    function apiUrl(path) {
      const base = new URL(document.baseURI || window.location.href)
      base.search = ''
      base.hash = ''
      if (!base.pathname.endsWith('/')) base.pathname = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1)
      return new URL(path.replace(/^\/+/, ''), base).href
    }

    /** One JSON call against the host half. */
    async function call(method, name, body) {
      const response = await fetch(apiUrl(`${API_ROOT}/${name}`), {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok || payload?.ok !== true) {
        const message = payload?.error?.message || `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload.value
    }

    /** HH:mm:ss for the log column. */
    function formatTime(timestamp) {
      const date = new Date(typeof timestamp === 'number' ? timestamp : Date.now())
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Compact duration text. */
    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '0s'
      const seconds = Math.floor(ms / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`
      const hours = Math.floor(minutes / 60)
      return `${hours}h ${minutes % 60}m`
    }

    /** Default canvas height for one node type. */
    function nodeHeightForType(type) {
      return type === 'parallel' || type === 'terminate' ? GATEWAY_HEIGHT : TASK_HEIGHT
    }

    /** Node box for layout math. */
    function nodeBox(node) {
      return { width: NODE_WIDTH, height: nodeHeightForType(node.type) }
    }

    /** Normalize a `#rrggbb` color to lower case; anything else is undefined. */
    function normalizeHexColor(value) {
      if (typeof value !== 'string') return undefined
      const match = /^#([0-9a-fA-F]{6})$/.exec(value.trim())
      return match === null ? undefined : `#${match[1].toLowerCase()}`
    }

    /** Effective workspace id for one task: node → workflow default → catalog default. */
    function resolveTaskWorkspaceId(task, workflowSettings, catalogDefaults) {
      const direct = task?.workspaceId
      if (typeof direct === 'string' && direct !== '') return direct
      const workflowDefault = workflowSettings?.defaultWorkspaceId
      if (typeof workflowDefault === 'string' && workflowDefault !== '') return workflowDefault
      const catalogDefault = catalogDefaults?.workspaceId
      if (typeof catalogDefault === 'string' && catalogDefault !== '') return catalogDefault
      return undefined
    }

    /** Display title for a workspace row (`title || path || id`). */
    function workspaceTitle(workspace, fallbackId) {
      const title = workspace?.title || workspace?.path
      return typeof title === 'string' && title !== '' ? title : fallbackId
    }

    /** Cubic edge path between two node ports. */
    function edgePath(from, to) {
      const fromBox = nodeBox(from)
      const toBox = nodeBox(to)
      const x1 = from.x + fromBox.width
      const y1 = from.y + fromBox.height / 2
      const x2 = to.x
      const y2 = to.y + toBox.height / 2
      const control = Math.max(46, Math.abs(x2 - x1) * 0.5)
      return `M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2} ${y2}`
    }

    /** Sidebar icon (registered as the panel-list occupant). */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 2.5, y: 3.5, width: 7, height: 5, rx: 1.4 }),
        h('rect', { x: 14.5, y: 3.5, width: 7, height: 5, rx: 1.4 }),
        h('rect', { x: 8.5, y: 15.5, width: 7, height: 5, rx: 1.4 }),
        h('path', { d: 'M6 8.5v2.2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8.5' }),
        h('path', { d: 'M12 12.7v2.8' }),
      )
    }

    /** Option rows for one select. */
    function optionRows(entries, placeholder) {
      const rows = []
      if (placeholder !== undefined) rows.push(h('option', { key: '__empty', value: '' }, placeholder))
      for (const entry of entries) rows.push(h('option', { key: entry.value, value: entry.value }, entry.label))
      return rows
    }

    /** Field wrapper for the inspector. */
    function field(label, control, hint, className) {
      return h(
        'div',
        { className: className ? `wfo-field ${className}` : 'wfo-field', key: label },
        h('label', null, label),
        control,
        hint ? h('div', { className: 'wfo-hint' }, hint) : null,
      )
    }

    /** Status pill. */
    function statusPill(status) {
      const label = RUN_STATUS_LABEL[status] ?? status
      return h('span', { className: `wfo-pill ${status ?? ''}` }, label)
    }

    // ---------------------------------------------------------------------
    // panel factory
    // ---------------------------------------------------------------------
    function createPanel(ctx) {
      return function WorkflowPanel() {
        const [loading, setLoading] = useState(true)
        const [workflows, setWorkflows] = useState([])
        const [activeWorkflowId, setActiveWorkflowId] = useState(null)
        const [catalogs, setCatalogs] = useState(null)
        const [engine, setEngine] = useState({ running: [], runs: [] })
        const [selectedNodeId, setSelectedNodeId] = useState(null)
        const [selectedEdgeId, setSelectedEdgeId] = useState(null)
        const [connecting, setConnecting] = useState(null)
        const [saveState, setSaveState] = useState('saved')
        const [notice, setNotice] = useState(null)
        const [stopDialogOpen, setStopDialogOpen] = useState(false)
        const [logClearedAt, setLogClearedAt] = useState(0)
        const [now, setNow] = useState(Date.now())

        const canvasWrapRef = useRef(null)
        const canvasInnerRef = useRef(null)
        const logBodyRef = useRef(null)
        const dragRef = useRef(null)
        const saveTimerRef = useRef(null)
        const workflowRef = useRef(null)
        const activeIdRef = useRef(null)
        const scheduleSaveRef = useRef(() => {})
        const handlersRef = useRef({})

        const activeWorkflow = useMemo(
          () => workflows.find((workflow) => workflow.id === activeWorkflowId) ?? null,
          [workflows, activeWorkflowId],
        )
        workflowRef.current = activeWorkflow
        activeIdRef.current = activeWorkflowId

        const currentRun = useMemo(() => {
          const runs = Array.isArray(engine.runs) ? engine.runs : []
          const own = runs.filter((run) => run.workflowId === activeWorkflowId)
          return own.length > 0 ? own[own.length - 1] : null
        }, [engine, activeWorkflowId])
        const runIsActive = useMemo(() => {
          if (!currentRun) return false
          return (engine.running ?? []).some((entry) => entry.runId === currentRun.id)
        }, [engine, currentRun])
        const nodeStates = currentRun?.nodes ?? {}
        const problems = activeWorkflow?.nodes ?? []
        const taskCount = problems.filter((node) => node.type === 'task').length
        const judgeCount = problems.filter((node) => node.type === 'judge').length
        const terminateCount = problems.filter((node) => node.type === 'terminate').length
        const gatewayCount = problems.filter((node) => node.type === 'parallel').length

        // Workspace grouping + colors for the current canvas (task nodes only).
        const workspaceInfo = useMemo(() => {
          const workflow = activeWorkflow
          const settings = workflow?.settings ?? {}
          const catalogDefaults = catalogs?.defaults
          const workspaceRows = Array.isArray(catalogs?.workspaces) ? catalogs.workspaces : []
          const workspaceById = new Map(workspaceRows.map((workspace) => [workspace.id, workspace]))
          const overrides =
            settings.workspaceColors !== null && typeof settings.workspaceColors === 'object'
              ? settings.workspaceColors
              : {}
          const order = []
          const countById = new Map()
          const nodeWorkspace = new Map()
          for (const node of workflow?.nodes ?? []) {
            if (node.type !== 'task' && node.type !== 'judge') continue
            const workspaceId = resolveTaskWorkspaceId(node.task, settings, catalogDefaults)
            if (workspaceId === undefined) continue
            if (!countById.has(workspaceId)) {
              order.push(workspaceId)
              countById.set(workspaceId, 0)
            }
            countById.set(workspaceId, countById.get(workspaceId) + 1)
            const direct = node.task?.workspaceId
            nodeWorkspace.set(node.id, {
              id: workspaceId,
              inherited: !(typeof direct === 'string' && direct !== ''),
            })
          }
          const entries = order.map((workspaceId, index) => {
            const override = normalizeHexColor(overrides[workspaceId])
            return {
              id: workspaceId,
              title: workspaceTitle(workspaceById.get(workspaceId), workspaceId),
              color: override ?? WORKSPACE_PALETTE[index % WORKSPACE_PALETTE.length],
              count: countById.get(workspaceId) ?? 0,
              overridden: override !== undefined,
            }
          })
          const entryById = new Map(entries.map((entry) => [entry.id, entry]))
          for (const info of nodeWorkspace.values()) {
            const entry = entryById.get(info.id)
            info.title = entry?.title ?? info.id
            info.color = entry?.color
          }
          return { entries, nodeWorkspace, multi: entries.length > 1 }
        }, [activeWorkflow, catalogs])

        // Execution scope of the current run, for the "执行范围" row.
        const runScope = useMemo(() => {
          const startNodeId = currentRun?.startNodeId
          if (typeof startNodeId !== 'string' || startNodeId === '') return null
          const nodes = activeWorkflow?.nodes ?? []
          const edges = activeWorkflow?.edges ?? []
          const nodeById = new Map(nodes.map((node) => [node.id, node]))
          const startNode = nodeById.get(startNodeId)
          const title = startNode?.title || currentRun?.nodes?.[startNodeId]?.title || startNodeId
          const reachable = new Set()
          if (startNode !== undefined) {
            const outgoing = new Map()
            for (const edge of edges) {
              if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
              outgoing.get(edge.from).push(edge.to)
            }
            const queue = [startNodeId]
            reachable.add(startNodeId)
            while (queue.length > 0) {
              const current = queue.shift()
              for (const next of outgoing.get(current) ?? []) {
                if (reachable.has(next) || !nodeById.has(next)) continue
                reachable.add(next)
                queue.push(next)
              }
            }
          }
          return { startNodeId, title, skipped: Math.max(0, nodes.length - reachable.size) }
        }, [activeWorkflow, currentRun])

        /** Show one transient banner. */
        const showNotice = useCallback((kind, text) => {
          setNotice({ kind, text, at: Date.now() })
        }, [])
        useEffect(() => {
          if (notice === null) return undefined
          const timer = setTimeout(() => setNotice(null), 5000)
          return () => clearTimeout(timer)
        }, [notice])

        // ---- persistence -------------------------------------------------
        const doSave = useCallback(async () => {
          const workflow = workflowRef.current
          if (workflow === null) return
          setSaveState('saving')
          try {
            await call('POST', 'save', { workflow })
            setSaveState('saved')
          } catch (error) {
            setSaveState('error')
            showNotice('error', `保存失败：${error.message}`)
          }
        }, [showNotice])

        const scheduleSave = useCallback(() => {
          setSaveState('saving')
          if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null
            void doSave()
          }, 600)
        }, [doSave])
        scheduleSaveRef.current = scheduleSave

        const flushSave = useCallback(async () => {
          if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current)
            saveTimerRef.current = null
          }
          await doSave()
        }, [doSave])

        // ---- state loading ----------------------------------------------
        const loadState = useCallback(async () => {
          const value = await call('GET', 'state')
          let nextWorkflows = Array.isArray(value.workflows) ? value.workflows : []
          let nextActive = value.activeWorkflowId
          if (nextWorkflows.length === 0) {
            const created = await call('POST', 'create', { name: '工作流 1' })
            nextWorkflows = [created.workflow]
            nextActive = created.workflow.id
          }
          if (!nextWorkflows.some((workflow) => workflow.id === nextActive)) nextActive = nextWorkflows[0]?.id ?? null
          setWorkflows(nextWorkflows)
          setActiveWorkflowId(nextActive)
          setCatalogs(value.catalogs ?? null)
          setEngine(value.engine ?? { running: [], runs: [] })
        }, [])

        useEffect(() => {
          let disposed = false
          ;(async () => {
            try {
              await loadState()
            } catch (error) {
              if (!disposed) showNotice('error', `加载工作流失败：${error.message}`)
            } finally {
              if (!disposed) setLoading(false)
            }
          })()
          return () => {
            disposed = true
            if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
          }
        }, [loadState, showNotice])

        // Poll run state (never the editable workflow definitions).
        useEffect(() => {
          let disposed = false
          const tick = async () => {
            try {
              const value = await call('GET', 'run')
              if (!disposed && value?.engine) setEngine(value.engine)
            } catch {
              /* a transient poll failure is not worth a banner */
            }
          }
          const timer = setInterval(() => {
            void tick()
          }, 1000)
          return () => {
            disposed = true
            clearInterval(timer)
          }
        }, [])

        // Elapsed-time ticker for the toolbar/log header.
        useEffect(() => {
          const timer = setInterval(() => setNow(Date.now()), 1000)
          return () => clearInterval(timer)
        }, [])

        // ---- workflow mutations -----------------------------------------
        const updateWorkflow = useCallback((updater) => {
          const id = activeIdRef.current
          if (id === null) return
          setWorkflows((previous) =>
            previous.map((workflow) => (workflow.id === id ? updater(workflow) : workflow)),
          )
          scheduleSaveRef.current()
        }, [])

        const switchWorkflow = useCallback(
          (workflowId) => {
            if (workflowId === activeWorkflowId) return
            void flushSave().catch(() => {})
            setActiveWorkflowId(workflowId)
            setSelectedNodeId(null)
            setSelectedEdgeId(null)
            void call('POST', 'active', { workflowId }).catch(() => {})
          },
          [activeWorkflowId, flushSave],
        )

        const createWorkflow = useCallback(async () => {
          try {
            await flushSave().catch(() => {})
            const name = `工作流 ${workflows.length + 1}`
            const created = await call('POST', 'create', {
              name,
              workspaceId: catalogs?.defaults?.workspaceId,
            })
            setWorkflows((previous) => [...previous, created.workflow])
            setActiveWorkflowId(created.workflow.id)
            setSelectedNodeId(null)
            setSelectedEdgeId(null)
            showNotice('info', `已新建「${created.workflow.name}」`)
          } catch (error) {
            showNotice('error', `新建失败：${error.message}`)
          }
        }, [catalogs, flushSave, showNotice, workflows.length])

        const deleteWorkflow = useCallback(async () => {
          if (activeWorkflow === null) return
          if (runIsActive) {
            showNotice('error', '工作流正在运行，先终止后再删除')
            return
          }
          if (!window.confirm(`确定删除工作流「${activeWorkflow.name}」吗？画布和运行记录会一并删除。`)) return
          try {
            await call('POST', 'delete', { workflowId: activeWorkflow.id })
            const remaining = workflows.filter((workflow) => workflow.id !== activeWorkflow.id)
            let next = remaining
            if (remaining.length === 0) {
              const created = await call('POST', 'create', { name: '工作流 1' })
              next = [created.workflow]
            }
            setWorkflows(next)
            setActiveWorkflowId(next[0]?.id ?? null)
            setSelectedNodeId(null)
            setSelectedEdgeId(null)
          } catch (error) {
            showNotice('error', `删除失败：${error.message}`)
          }
        }, [activeWorkflow, runIsActive, showNotice, workflows])

        /** Build a fresh node with the current catalog defaults. */
        const makeNode = useCallback(
          (type, x, y) => {
            const defaults = catalogs?.defaults ?? {}
            const base = {
              id: `node-${Math.random().toString(36).slice(2, 10)}`,
              type,
              x,
              y,
            }
            if (type === 'parallel') return { ...base, title: '并行网关' }
            if (type === 'terminate') return { ...base, title: '终止节点', control: { stopPolicy: 'detach' } }
            const task = { prompt: '', contextMode: 'full' }
            if (typeof defaults.workspaceId === 'string') task.workspaceId = defaults.workspaceId
            if (typeof defaults.agentPreset === 'string') task.agentPreset = defaults.agentPreset
            if (typeof defaults.permissionPreset === 'string') task.permissionPreset = defaults.permissionPreset
            if (defaults.model) task.model = { ...defaults.model }
            if (type === 'judge') {
              const index = (workflowRef.current?.nodes ?? []).filter((node) => node.type === 'judge').length + 1
              return { ...base, title: `判断 ${index}`, task, control: { onInvalid: 'continue', stopPolicy: 'detach' } }
            }
            const index = (workflowRef.current?.nodes ?? []).filter((node) => node.type === 'task').length + 1
            return { ...base, title: `任务 ${index}`, task }
          },
          [catalogs],
        )

        const addNode = useCallback(
          (type, x, y) => {
            const node = makeNode(type, Math.max(0, Math.round(x)), Math.max(0, Math.round(y)))
            updateWorkflow((workflow) => ({ ...workflow, nodes: [...workflow.nodes, node] }))
            setSelectedNodeId(node.id)
            setSelectedEdgeId(null)
          },
          [makeNode, updateWorkflow],
        )

        const updateNode = useCallback(
          (nodeId, patch) => {
            updateWorkflow((workflow) => ({
              ...workflow,
              nodes: workflow.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
            }))
          },
          [updateWorkflow],
        )

        const updateTask = useCallback(
          (nodeId, patch) => {
            updateWorkflow((workflow) => ({
              ...workflow,
              nodes: workflow.nodes.map((node) =>
                node.id === nodeId ? { ...node, task: { ...node.task, ...patch } } : node,
              ),
            }))
          },
          [updateWorkflow],
        )

        const updateControl = useCallback(
          (nodeId, patch) => {
            updateWorkflow((workflow) => ({
              ...workflow,
              nodes: workflow.nodes.map((node) =>
                node.id === nodeId ? { ...node, control: { ...(node.control ?? {}), ...patch } } : node,
              ),
            }))
          },
          [updateWorkflow],
        )

        /** Persist one explicit workspace color override. */
        const setWorkspaceColor = useCallback(
          (workspaceId, color) => {
            if (typeof workspaceId !== 'string' || workspaceId === '') return
            const normalized = normalizeHexColor(color)
            if (normalized === undefined) return
            updateWorkflow((workflow) => {
              const nextSettings = { ...(workflow.settings ?? {}) }
              const previousColors =
                nextSettings.workspaceColors !== null && typeof nextSettings.workspaceColors === 'object'
                  ? nextSettings.workspaceColors
                  : {}
              nextSettings.workspaceColors = { ...previousColors, [workspaceId]: normalized }
              return { ...workflow, settings: nextSettings }
            })
          },
          [updateWorkflow],
        )

        /** Drop one override so the palette color applies again. */
        const resetWorkspaceColor = useCallback(
          (workspaceId) => {
            updateWorkflow((workflow) => {
              const currentColors = workflow.settings?.workspaceColors
              if (currentColors === null || typeof currentColors !== 'object') return workflow
              const nextColors = { ...currentColors }
              delete nextColors[workspaceId]
              const nextSettings = { ...(workflow.settings ?? {}) }
              if (Object.keys(nextColors).length === 0) delete nextSettings.workspaceColors
              else nextSettings.workspaceColors = nextColors
              return { ...workflow, settings: nextSettings }
            })
          },
          [updateWorkflow],
        )

        const removeNode = useCallback(
          (nodeId) => {
            updateWorkflow((workflow) => ({
              ...workflow,
              nodes: workflow.nodes.filter((node) => node.id !== nodeId),
              edges: workflow.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
            }))
            setSelectedNodeId((current) => (current === nodeId ? null : current))
          },
          [updateWorkflow],
        )

        const addEdge = useCallback(
          (from, to) => {
            if (from === to) return
            const workflow = workflowRef.current
            if (workflow === null) return
            if (workflow.edges.some((edge) => edge.from === from && edge.to === to)) {
              showNotice('info', '这两个节点已经连过线了')
              return
            }
            const edge = { id: `edge-${Math.random().toString(36).slice(2, 10)}`, from, to }
            updateWorkflow((current) => ({ ...current, edges: [...current.edges, edge] }))
          },
          [showNotice, updateWorkflow],
        )

        // ---- canvas geometry --------------------------------------------
        const pointFromEvent = useCallback((event) => {
          const inner = canvasInnerRef.current
          if (inner === null) return { x: 0, y: 0 }
          const rect = inner.getBoundingClientRect()
          return { x: event.clientX - rect.left, y: event.clientY - rect.top }
        }, [])

        const startNodeDrag = useCallback(
          (event, node) => {
            if (event.button !== 0) return
            if (event.target?.closest?.('[data-port]')) return
            event.stopPropagation()
            setSelectedNodeId(node.id)
            setSelectedEdgeId(null)
            dragRef.current = {
              kind: 'node',
              nodeId: node.id,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: node.x,
              originY: node.y,
            }
          },
          [],
        )

        const startConnect = useCallback(
          (event, node) => {
            if (event.button !== 0) return
            event.stopPropagation()
            event.preventDefault()
            const point = pointFromEvent(event)
            dragRef.current = { kind: 'connect', fromId: node.id, pointerId: event.pointerId }
            setConnecting({ fromId: node.id, x: point.x, y: point.y })
            setSelectedNodeId(node.id)
            setSelectedEdgeId(null)
          },
          [pointFromEvent],
        )

        // Global pointer listeners keep drags working outside the node.
        useEffect(() => {
          const onMove = (event) => {
            const drag = dragRef.current
            if (drag === null) return
            if (drag.kind === 'node') {
              const dx = event.clientX - drag.startX
              const dy = event.clientY - drag.startY
              const x = Math.max(0, Math.round(drag.originX + dx))
              const y = Math.max(0, Math.round(drag.originY + dy))
              setWorkflows((previous) =>
                previous.map((workflow) =>
                  workflow.id === activeIdRef.current
                    ? {
                        ...workflow,
                        nodes: workflow.nodes.map((node) =>
                          node.id === drag.nodeId ? { ...node, x, y } : node,
                        ),
                      }
                    : workflow,
                ),
              )
              return
            }
            if (drag.kind === 'connect') {
              const point = pointFromEvent(event)
              setConnecting({ fromId: drag.fromId, x: point.x, y: point.y })
            }
          }
          const onUp = (event) => {
            const drag = dragRef.current
            if (drag === null) return
            dragRef.current = null
            if (drag.kind === 'node') {
              scheduleSaveRef.current()
              return
            }
            if (drag.kind === 'connect') {
              const fromId = drag.fromId
              setConnecting(null)
              const element = document.elementFromPoint(event.clientX, event.clientY)
              const port = element?.closest?.('[data-port-in]')
              const targetId = port?.getAttribute('data-port-in')
              if (typeof targetId === 'string' && targetId !== '' && targetId !== fromId) {
                if (workflowRef.current?.nodes.some((node) => node.id === targetId)) addEdge(fromId, targetId)
              }
            }
          }
          handlersRef.current.onMove = onMove
          handlersRef.current.onUp = onUp
          const move = (event) => handlersRef.current.onMove?.(event)
          const up = (event) => handlersRef.current.onUp?.(event)
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
          window.addEventListener('pointercancel', up)
          return () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', up)
          }
        }, [addEdge, pointFromEvent])

        // Delete key removes the selected node or edge while not editing text.
        useEffect(() => {
          const onKeyDown = (event) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return
            const target = event.target
            if (
              target !== null &&
              (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT' ||
                target.isContentEditable === true)
            ) {
              return
            }
            if (selectedNodeId !== null) {
              event.preventDefault()
              removeNode(selectedNodeId)
              return
            }
            if (selectedEdgeId !== null) {
              event.preventDefault()
              updateWorkflow((workflow) => ({
                ...workflow,
                edges: workflow.edges.filter((edge) => edge.id !== selectedEdgeId),
              }))
              setSelectedEdgeId(null)
            }
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [removeNode, selectedEdgeId, selectedNodeId, updateWorkflow])

        const canvasDrop = useCallback(
          (event) => {
            event.preventDefault()
            const type = event.dataTransfer?.getData(TASK_DRAG_TYPE) || event.dataTransfer?.getData('text/plain')
            if (type !== 'task' && type !== 'parallel' && type !== 'judge' && type !== 'terminate') return
            const point = pointFromEvent(event)
            const height = nodeHeightForType(type)
            addNode(type, point.x - NODE_WIDTH / 2, point.y - height / 2)
          },
          [addNode, pointFromEvent],
        )

        const addFromPalette = useCallback(
          (type) => {
            const wrap = canvasWrapRef.current
            const point = wrap
              ? { x: wrap.scrollLeft + wrap.clientWidth / 2, y: wrap.scrollTop + wrap.clientHeight / 2 }
              : { x: 320, y: 220 }
            const height = nodeHeightForType(type)
            const offset = (workflowRef.current?.nodes?.length ?? 0) % 6
            addNode(type, point.x - NODE_WIDTH / 2 + offset * 34, point.y - height / 2 + offset * 26)
          },
          [addNode],
        )

        // ---- run actions -------------------------------------------------
        const startRun = useCallback(
          async (startNodeId, startTitle) => {
            if (activeWorkflow === null) return
            try {
              await flushSave()
              const body = { workflowId: activeWorkflow.id, workflow: workflowRef.current }
              const scoped = typeof startNodeId === 'string' && startNodeId !== ''
              if (scoped) body.startNodeId = startNodeId
              const value = await call('POST', 'run', body)
              setEngine((previous) => ({ ...previous, ...(value.engine ?? {}) }))
              setLogClearedAt(0)
              if (scoped) {
                const title = typeof startTitle === 'string' && startTitle.trim() !== '' ? startTitle.trim() : '未命名任务'
                showNotice('info', `已从「${title}」开始执行`)
              } else {
                showNotice('info', '工作流已启动')
              }
            } catch (error) {
              showNotice('error', `启动失败：${error.message}`)
            }
          },
          [activeWorkflow, flushSave, showNotice],
        )

        const stopRun = useCallback(
          async (cancelTasks) => {
            setStopDialogOpen(false)
            if (currentRun === null) return
            try {
              const value = await call('POST', 'stop', { runId: currentRun.id, cancelTasks })
              setEngine((previous) => ({ ...previous, ...(value.engine ?? {}) }))
              showNotice('info', cancelTasks ? '已请求停止工作流并终止运行中的任务' : '已请求停止工作流，运行中的任务将继续执行')
            } catch (error) {
              showNotice('error', `终止失败：${error.message}`)
            }
          },
          [currentRun, showNotice],
        )

        const openTaskSession = useCallback(
          (sessionId) => {
            if (typeof sessionId !== 'string' || sessionId === '') return
            try {
              const uiWorkspace = ctx.get('uiWorkspace')
              if (typeof uiWorkspace?.openSession === 'function') {
                uiWorkspace.openSession(sessionId)
                return
              }
            } catch {
              /* fall through to the clipboard */
            }
            try {
              void navigator.clipboard?.writeText(sessionId)
              showNotice('info', `已复制会话 ID：${sessionId}`)
            } catch {
              showNotice('info', `会话 ID：${sessionId}`)
            }
          },
          [ctx, showNotice],
        )

        // Auto-scroll the log to its newest line.
        useEffect(() => {
          const body = logBodyRef.current
          if (body !== null) body.scrollTop = body.scrollHeight
        }, [currentRun?.id, currentRun?.log?.length])

        // -----------------------------------------------------------------
        // render helpers
        // -----------------------------------------------------------------
        const renderPorts = (node) => {
          const ports = [
            h('span', {
              key: 'in',
              className: 'wfo-port in',
              'data-port': 'in',
              'data-port-in': node.id,
              title: '连入：从这里接到上一个节点的输出',
            }),
          ]
          if (node.type !== 'terminate') {
            ports.push(
              h('span', {
                key: 'out',
                className: 'wfo-port out',
                'data-port': 'out',
                title: '连出：拖到下一个节点左侧的圆点',
                onPointerDown: (event) => startConnect(event, node),
              }),
            )
          }
          return ports
        }

        const renderNode = (node) => {
          const state = nodeStates[node.id]
          const status = state?.status ?? 'pending'
          const statusClass = status === 'pending' ? '' : status
          const isSelected = node.id === selectedNodeId
          const sessionId = state?.sessionId
          const title = node.title ?? ''
          if (node.type === 'parallel') {
            return h(
              'div',
              {
                key: node.id,
                className: `wfo-node gateway ${isSelected ? 'selected' : ''} is-${statusClass}`,
                style: { left: node.x, top: node.y, width: NODE_WIDTH, height: GATEWAY_HEIGHT },
                onPointerDown: (event) => startNodeDrag(event, node),
                onClick: (event) => {
                  event.stopPropagation()
                  setSelectedNodeId(node.id)
                  setSelectedEdgeId(null)
                },
              },
              renderPorts(node),
              h('div', { className: 'wfo-gw-diamond' }),
              h(
                'div',
                { className: 'wfo-gw-text' },
                h('b', null, title),
                h('span', null, '等待所有输入分支完成'),
                h('span', { className: `wfo-node-status ${status}` }, NODE_STATUS_LABEL[status] ?? status),
              ),
            )
          }
          if (node.type === 'terminate') {
            return h(
              'div',
              {
                key: node.id,
                className: `wfo-node terminate ${isSelected ? 'selected' : ''} is-${statusClass}`,
                style: { left: node.x, top: node.y, width: NODE_WIDTH, height: GATEWAY_HEIGHT },
                onPointerDown: (event) => startNodeDrag(event, node),
                onClick: (event) => {
                  event.stopPropagation()
                  setSelectedNodeId(node.id)
                  setSelectedEdgeId(null)
                },
              },
              renderPorts(node),
              h('div', { className: 'wfo-terminate-icon' }),
              h(
                'div',
                { className: 'wfo-gw-text' },
                h('b', null, title),
                h('span', null, '到达即提前结束工作流'),
                h('span', { className: `wfo-node-status ${status}` }, NODE_STATUS_LABEL[status] ?? status),
              ),
            )
          }
          const isJudge = node.type === 'judge'
          const decision = state?.decision
          const promptPreview = node.task?.prompt?.trim() ?? ''
          const nodeWorkspaceInfo = workspaceInfo.nodeWorkspace.get(node.id)
          return h(
            'div',
            {
              key: node.id,
              className: `wfo-node ${isSelected ? 'selected' : ''} is-${statusClass}`,
              style: {
                left: node.x,
                top: node.y,
                width: NODE_WIDTH,
                height: TASK_HEIGHT,
                backgroundColor:
                  nodeWorkspaceInfo === undefined
                    ? undefined
                    : `color-mix(in srgb, ${nodeWorkspaceInfo.color} 13%, var(--dsw-alias-bg-base,#fff))`,
              },
              onPointerDown: (event) => startNodeDrag(event, node),
              onClick: (event) => {
                event.stopPropagation()
                setSelectedNodeId(node.id)
                setSelectedEdgeId(null)
              },
            },
            renderPorts(node),
            h(
              'div',
              { className: 'wfo-node-head' },
              h('span', { className: `wfo-node-badge ${isJudge ? 'judge' : ''}` }, isJudge ? '判断' : '任务'),
              h('span', { className: 'wfo-node-title', title }, title),
              h('span', { className: `wfo-node-status ${status}` }, NODE_STATUS_LABEL[status] ?? status),
            ),
            h(
              'div',
              { className: `wfo-node-prompt ${promptPreview === '' ? 'empty' : ''}` },
              promptPreview === '' ? (isJudge ? '尚未填写判定提示词' : '尚未填写提示词') : promptPreview,
            ),
            h(
              'div',
              {
                className: nodeWorkspaceInfo === undefined ? 'wfo-node-workspace empty' : 'wfo-node-workspace',
                title:
                  nodeWorkspaceInfo === undefined
                    ? '尚未解析到任务会话的工作区'
                    : `工作区：${nodeWorkspaceInfo.title}（${nodeWorkspaceInfo.inherited ? '继承工作流默认' : '节点指定'}）`,
              },
              nodeWorkspaceInfo === undefined
                ? h('span', { className: 'wfo-node-ws-name' }, '未设置工作区')
                : [
                    h('span', {
                      key: 'dot',
                      className: 'wfo-node-ws-dot',
                      style: { backgroundColor: nodeWorkspaceInfo.color },
                    }),
                    h('span', { key: 'name', className: 'wfo-node-ws-name' }, nodeWorkspaceInfo.title),
                    nodeWorkspaceInfo.inherited
                      ? h('span', { key: 'tag', className: 'wfo-node-ws-tag' }, '默认')
                      : null,
                  ],
            ),
            h(
              'div',
              { className: 'wfo-node-meta' },
              h('span', null, node.task?.contextMode === 'none' ? '不带上游' : node.task?.contextMode === 'summary' ? '带上游摘要' : '带上游输出'),
              decision ? h('span', { title: '判断节点的判定结果' }, decision === 'STOP' ? '判定：终止' : '判定：继续') : null,
              sessionId ? h('span', { title: sessionId }, `· ${String(sessionId).slice(0, 12)}…`) : null,
            ),
          )
        }

        const renderPalette = () => {
          const items = [
            {
              type: 'task',
              label: '任务节点',
              desc: '新建一个真实任务会话，填提示词、工作区、模式、权限和模型。',
              glyph: h(
                'svg',
                { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
                h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }),
                h('path', { d: 'M8 9h8M8 13h5' }),
              ),
            },
            {
              type: 'parallel',
              label: '并行网关',
              desc: '等待所有连入分支完成后，再同时触发后续节点。',
              glyph: h(
                'svg',
                { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
                h('path', { d: 'M12 3l9 9-9 9-9-9z' }),
              ),
            },
            {
              type: 'judge',
              label: '判断节点',
              desc: '新增一个真实会话来评估上游输出，判定继续或提前结束工作流。',
              glyph: h(
                'svg',
                { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
                h('path', { d: 'M12 4v5M12 9l-5 5M12 9l5 5' }),
                h('circle', { cx: 12, cy: 3.5, r: 1.6 }),
                h('circle', { cx: 6, cy: 17, r: 1.6 }),
                h('circle', { cx: 18, cy: 17, r: 1.6 }),
              ),
            },
            {
              type: 'terminate',
              label: '终止节点',
              desc: '到达后立即提前结束本次工作流，后续节点不再执行。',
              glyph: h(
                'svg',
                { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
                h('rect', { x: 5, y: 5, width: 14, height: 14, rx: 3 }),
                h('rect', { x: 9.5, y: 9.5, width: 5, height: 5, rx: 1, fill: 'currentColor' }),
              ),
            },
          ]
          return h(
            'div',
            { className: 'wfo-palette' },
            h('div', { className: 'wfo-palette-title' }, '工作流节点'),
            items.map((item) =>
              h(
                'div',
                {
                  key: item.type,
                  className: 'wfo-pal-item',
                  draggable: true,
                  onDragStart: (event) => {
                    event.dataTransfer.setData(TASK_DRAG_TYPE, item.type)
                    event.dataTransfer.setData('text/plain', item.type)
                    event.dataTransfer.effectAllowed = 'copy'
                  },
                  onClick: () => addFromPalette(item.type),
                  title: '拖到中间画布，或点击直接添加',
                },
                h(
                  'div',
                  { className: 'wfo-pal-head' },
                  h(
                    'span',
                    {
                      className: `wfo-pal-icon ${
                        item.type === 'task'
                          ? 'task'
                          : item.type === 'parallel'
                            ? 'gw'
                            : item.type === 'judge'
                              ? 'judge'
                              : 'stop'
                      }`,
                    },
                    item.glyph,
                  ),
                  h('span', null, item.label),
                ),
                h('div', { className: 'wfo-pal-desc' }, item.desc),
              ),
            ),
            h('div', { className: 'wfo-pal-foot' }, '拖拽节点到画布；从节点右侧圆点拖到另一个节点左侧圆点即可连线。'),
          )
        }

        const renderCanvas = () => {
          const nodes = activeWorkflow?.nodes ?? []
          const edges = activeWorkflow?.edges ?? []
          const nodeById = new Map(nodes.map((node) => [node.id, node]))
          const maxX = nodes.reduce((max, node) => Math.max(max, node.x + NODE_WIDTH + 320), 0)
          const maxY = nodes.reduce((max, node) => Math.max(max, node.y + TASK_HEIGHT + 240), 0)
          const empty = nodes.length === 0
          const innerWidth = empty ? '100%' : Math.max(maxX, 1280)
          const innerHeight = empty ? '100%' : Math.max(maxY, 820)
          return h(
            'div',
            {
              className: 'wfo-canvas-wrap',
              ref: canvasWrapRef,
              onDragOver: (event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
              },
              onDrop: canvasDrop,
              onClick: () => {
                setSelectedNodeId(null)
                setSelectedEdgeId(null)
              },
            },
            h(
              'div',
              {
                className: 'wfo-canvas-inner',
                ref: canvasInnerRef,
                style: { width: innerWidth, height: innerHeight },
              },
              empty
                ? h(
                    'div',
                    { className: 'wfo-inner-hint' },
                    h('b', null, '开始编排你的工作流'),
                    h('span', null, '从左侧拖入「任务节点」「判断节点」「终止节点」或「并行网关」；不连线的任务会同时启动。'),
                  )
                : null,
              h(
                'svg',
                { className: 'wfo-edges', width: innerWidth, height: innerHeight },
                h(
                  'defs',
                  null,
                  h(
                    'marker',
                    {
                      id: 'wfo-arrow',
                      viewBox: '0 0 10 10',
                      refX: 9,
                      refY: 5,
                      markerWidth: 7,
                      markerHeight: 7,
                      orient: 'auto-start-reverse',
                    },
                    h('path', { d: 'M 0 1 L 9 5 L 0 9 z', fill: 'context-stroke' }),
                  ),
                ),
                edges.map((edge) => {
                  const from = nodeById.get(edge.from)
                  const to = nodeById.get(edge.to)
                  if (from === undefined || to === undefined) return null
                  const selected = edge.id === selectedEdgeId
                  return h('path', {
                    key: edge.id,
                    className: `wfo-edge ${selected ? 'selected' : ''}`,
                    d: edgePath(from, to),
                    markerEnd: 'url(#wfo-arrow)',
                    onClick: (event) => {
                      event.stopPropagation()
                      setSelectedEdgeId(edge.id)
                      setSelectedNodeId(null)
                    },
                  })
                }),
                connecting
                  ? (() => {
                      const from = nodeById.get(connecting.fromId)
                      if (from === undefined) return null
                      const box = nodeBox(from)
                      const x1 = from.x + box.width
                      const y1 = from.y + box.height / 2
                      const control = Math.max(40, Math.abs(connecting.x - x1) * 0.5)
                      const d = `M ${x1} ${y1} C ${x1 + control} ${y1}, ${connecting.x - control} ${connecting.y}, ${connecting.x} ${connecting.y}`
                      return h('path', { className: 'wfo-edge temp', d, markerEnd: 'url(#wfo-arrow)' })
                    })()
                  : null,
              ),
              nodes.map(renderNode),
            ),
          )
        }

        const renderModelSelect = () => {
          const task = activeWorkflow?.nodes?.find((node) => node.id === selectedNodeId)?.task
          if (task === undefined) return null
          const selectedModel = task.model
          const value = selectedModel ? `${selectedModel.provider}::${selectedModel.model}` : ''
          const groups = Array.isArray(catalogs?.modelProviders) ? catalogs.modelProviders : []
          const children = [h('option', { key: '__default', value: '' }, '使用默认模型')]
          for (const provider of groups) {
            const rows = provider.models.map((model) =>
              h('option', { key: `${provider.id}::${model.id}`, value: `${provider.id}::${model.id}` }, model.name),
            )
            if (rows.length > 0) children.push(h('optgroup', { key: provider.id, label: provider.name }, rows))
          }
          return h(
            'select',
            {
              className: 'wfo-select',
              value,
              onChange: (event) => {
                const next = event.target.value
                if (next === '') {
                  const nextTask = { ...task }
                  delete nextTask.model
                  updateWorkflow((workflow) => ({
                    ...workflow,
                    nodes: workflow.nodes.map((node) =>
                      node.id === selectedNodeId ? { ...node, task: nextTask } : node,
                    ),
                  }))
                  return
                }
                const separator = next.indexOf('::')
                const provider = next.slice(0, separator)
                const model = next.slice(separator + 2)
                updateTask(selectedNodeId, { model: { provider, model } })
              },
            },
            children,
          )
        }

        /** Color rows for every workspace used by the current canvas. */
        const renderWorkspaceColors = () => {
          if (workspaceInfo.entries.length === 0) {
            return h(
              'div',
              { className: 'wfo-ws-colors' },
              h('div', { className: 'wfo-hint' }, '画布中还没有使用工作区的任务节点或判断节点'),
            )
          }
          return h(
            'div',
            { className: 'wfo-ws-colors' },
            workspaceInfo.entries.map((entry) =>
              h(
                'div',
                { className: 'wfo-ws-color-row', key: entry.id },
                h('span', { className: 'wfo-ws-color-dot', style: { backgroundColor: entry.color } }),
                h('span', { className: 'wfo-ws-color-name', title: entry.title }, entry.title),
                h('span', { className: 'wfo-ws-count' }, `${entry.count} 个节点`),
                h('input', {
                  className: 'wfo-color-input',
                  type: 'color',
                  value: entry.color,
                  title: `设置「${entry.title}」的节点卡片背景色`,
                  onChange: (event) => setWorkspaceColor(entry.id, event.target.value),
                }),
                entry.overridden
                  ? h(
                      'button',
                      {
                        className: 'wfo-btn small ghost',
                        title: '恢复正常调色板颜色',
                        onClick: () => resetWorkspaceColor(entry.id),
                      },
                      '恢复默认',
                    )
                  : null,
              ),
            ),
          )
        }

        const renderInspector = () => {
          const node = activeWorkflow?.nodes?.find((entry) => entry.id === selectedNodeId)
          if (node === undefined) {
            const settings = activeWorkflow?.settings ?? {}
            const workspaceRows = (catalogs?.workspaces ?? []).map((workspace) => ({
              value: workspace.id,
              label: workspace.title || workspace.path || workspace.id,
            }))
            return h(
              'div',
              { className: 'wfo-inspector' },
              h(
                'div',
                { className: 'wfo-insp-empty' },
                h('div', { className: 'wfo-empty-card' }, '在画布中选择一个节点，即可在这里编辑它的提示词、工作区、模式、权限与模型。'),
                activeWorkflow === null
                  ? null
                  : h(
                      'div',
                      null,
                      field(
                        '工作流默认工作区',
                        h(
                          'select',
                          {
                            className: 'wfo-select',
                            value: settings.defaultWorkspaceId ?? '',
                            onChange: (event) => {
                              const value = event.target.value
                              updateWorkflow((workflow) => {
                                const nextSettings = { ...(workflow.settings ?? {}) }
                                if (value === '') delete nextSettings.defaultWorkspaceId
                                else nextSettings.defaultWorkspaceId = value
                                return { ...workflow, settings: nextSettings }
                              })
                            },
                          },
                          optionRows(workspaceRows, '未设置'),
                        ),
                        '节点未单独选择工作区时，使用这里的工作区。',
                      ),
                      field(
                        '节点工作区配色',
                        renderWorkspaceColors(),
                        '背景色仅用于画布区分，不改变任务会话所属工作区；卡片边框仍表示运行状态。',
                      ),
                      h(
                        'div',
                        { className: 'wfo-empty-card' },
                        `当前画布：${taskCount} 个任务节点，${judgeCount} 个判断节点，${terminateCount} 个终止节点，${gatewayCount} 个并行网关。`,
                        h('br'),
                        '键盘 Delete 可以删除选中的节点或连线。',
                      ),
                    ),
              ),
            )
          }

          if (node.type === 'parallel') {
            return h(
              'div',
              { className: 'wfo-inspector' },
              h(
                'div',
                { className: 'wfo-insp-head' },
                h('span', { className: 'wfo-node-badge gw' }, '网关'),
                h('h3', null, node.title || '并行网关'),
              ),
              field(
                '节点名称',
                h('input', {
                  className: 'wfo-input',
                  value: node.title ?? '',
                  onChange: (event) => updateNode(node.id, { title: event.target.value }),
                }),
              ),
              h(
                'div',
                { className: 'wfo-insp-empty' },
                h(
                  'div',
                  { className: 'wfo-empty-card' },
                  '并行网关不创建任务会话，只负责汇合：所有连入分支都完成后，它才会激活后续节点。',
                ),
              ),
              h('div', { className: 'wfo-divider' }),
              h(
                'button',
                {
                  className: 'wfo-btn danger',
                  onClick: () => removeNode(node.id),
                },
                '删除网关',
              ),
            )
          }

          if (node.type === 'terminate') {
            const control = node.control ?? {}
            const policy = STOP_POLICY_OPTIONS.find((option) => option.value === (control.stopPolicy ?? 'detach'))
            return h(
              'div',
              { className: 'wfo-inspector' },
              h(
                'div',
                { className: 'wfo-insp-head' },
                h('span', { className: 'wfo-node-badge stop' }, '终止'),
                h('h3', null, node.title || '终止节点'),
              ),
              field(
                '节点名称',
                h('input', {
                  className: 'wfo-input',
                  value: node.title ?? '',
                  onChange: (event) => updateNode(node.id, { title: event.target.value }),
                }),
              ),
              field(
                '终止原因',
                h('input', {
                  className: 'wfo-input',
                  value: control.reason ?? '',
                  placeholder: '可选，例如：结果已足够，无需继续',
                  onChange: (event) => updateControl(node.id, { reason: event.target.value }),
                }),
                '会写入运行日志和运行记录，便于说明为什么提前结束。',
              ),
              field(
                '终止后在途任务',
                h(
                  'select',
                  {
                    className: 'wfo-select',
                    value: control.stopPolicy ?? 'detach',
                    onChange: (event) => updateControl(node.id, { stopPolicy: event.target.value }),
                  },
                  STOP_POLICY_OPTIONS.map((option) =>
                    h('option', { key: option.value, value: option.value }, option.label),
                  ),
                ),
                policy?.hint,
              ),
              h(
                'div',
                { className: 'wfo-insp-empty' },
                h(
                  'div',
                  { className: 'wfo-empty-card' },
                  '终止节点不创建任务会话。所有前序任务完成后，它会立即提前结束本次工作流：未启动的节点标记为「已跳过」，在途任务按上面的策略处理。',
                ),
              ),
              h('div', { className: 'wfo-divider' }),
              h(
                'button',
                {
                  className: 'wfo-btn danger',
                  onClick: () => removeNode(node.id),
                },
                '删除终止节点',
              ),
            )
          }

          const task = node.task ?? {}
          const isJudge = node.type === 'judge'
          const control = node.control ?? {}
          const state = nodeStates[node.id]
          const sessionId = state?.sessionId
          const workspaceRows = (catalogs?.workspaces ?? []).map((workspace) => ({
            value: workspace.id,
            label: workspace.title || workspace.path || workspace.id,
          }))
          const presetRows = (catalogs?.agentPresets ?? []).map((preset) => ({
            value: preset.id,
            label: preset.name,
          }))
          const permissionRows = (catalogs?.permissions ?? []).map((option) => ({
            value: option.value,
            label: option.name,
          }))
          const contextHint = CONTEXT_MODE_OPTIONS.find((option) => option.value === (task.contextMode ?? 'full'))?.hint
          const promptText = typeof task.prompt === 'string' ? task.prompt.trim() : ''
          const startFromNodeDisabled = runIsActive || promptText === ''
          const startFromNodeTitle = runIsActive
            ? '工作流正在运行，先终止后再从节点开始执行'
            : promptText === ''
              ? '该节点还没有填写提示词，无法从它开始执行'
              : '跳过该节点之前的所有节点，从该节点及其下游开始执行'
          return h(
            'div',
            { className: 'wfo-inspector' },
            h(
              'div',
              { className: 'wfo-insp-head' },
              h('span', { className: `wfo-node-badge ${isJudge ? 'judge' : ''}` }, isJudge ? '判断' : '任务'),
              h('h3', null, node.title || (isJudge ? '判断节点' : '任务节点')),
            ),
            isJudge
              ? null
              : h(
                  'div',
                  { className: 'wfo-start-here' },
                  h(
                    'button',
                    {
                      className: 'wfo-btn primary',
                      disabled: startFromNodeDisabled,
                      title: startFromNodeTitle,
                      onClick: () => {
                        if (startFromNodeDisabled) return
                        void startRun(node.id, node.title)
                      },
                    },
                    '从此节点开始执行',
                  ),
                ),
            field(
              '节点名称',
              h('input', {
                className: 'wfo-input',
                value: node.title ?? '',
                onChange: (event) => updateNode(node.id, { title: event.target.value }),
              }),
            ),
            field(
              isJudge ? '判定提示词' : '提示词',
              h('textarea', {
                className: 'wfo-textarea',
                value: task.prompt ?? '',
                placeholder: isJudge
                  ? '写清楚评估标准：什么情况下应该继续、什么情况下应该终止。Enter 只换行；引擎会在末尾自动追加判定输出契约。'
                  : '输入这个任务会话要执行的提示词。Enter 只换行，不会启动任务；点击顶部「执行」才会按编排启动工作流。',
                onChange: (event) => updateTask(node.id, { prompt: event.target.value }),
              }),
              isJudge ? '判断节点会创建一个真实任务会话，按这段指令评估上游输出。' : null,
              'prompt',
            ),
            field(
              '上游上下文',
              h(
                'select',
                {
                  className: 'wfo-select',
                  value: task.contextMode ?? 'full',
                  onChange: (event) => updateTask(node.id, { contextMode: event.target.value }),
                },
                CONTEXT_MODE_OPTIONS.map((option) =>
                  h('option', { key: option.value, value: option.value }, option.label),
                ),
              ),
              contextHint,
            ),
            isJudge
              ? field(
                  '判定输出契约',
                  h(
                    'div',
                    { className: 'wfo-empty-card' },
                    '引擎会自动在提示词末尾追加：最后单独一行输出 WOF_DECISION: CONTINUE（继续）或 WOF_DECISION: STOP（终止）。判定 STOP 时工作流提前结束，后续节点不再执行。',
                  ),
                  '下游任务仍会收到被判断任务的上游输出；判断节点本身对上下文透明。',
                )
              : null,
            isJudge
              ? field(
                  '无效判定处理',
                  h(
                    'select',
                    {
                      className: 'wfo-select',
                      value: control.onInvalid ?? 'continue',
                      onChange: (event) => updateControl(node.id, { onInvalid: event.target.value }),
                    },
                    ON_INVALID_OPTIONS.map((option) =>
                      h('option', { key: option.value, value: option.value }, option.label),
                    ),
                  ),
                  ON_INVALID_OPTIONS.find((option) => option.value === (control.onInvalid ?? 'continue'))?.hint,
                )
              : null,
            field(
              '工作区',
              h(
                'select',
                {
                  className: 'wfo-select',
                  value: task.workspaceId ?? '',
                  onChange: (event) => {
                    const value = event.target.value
                    updateTask(node.id, { workspaceId: value === '' ? undefined : value })
                  },
                },
                optionRows(workspaceRows, '使用工作流默认工作区'),
              ),
              workspaceInfo.multi
                ? `新建的任务会话会出现在这个工作区的任务列表里。当前工作流涉及 ${workspaceInfo.entries.length} 个工作区，卡片背景色用于区分。`
                : '新建的任务会话会出现在这个工作区的任务列表里。',
            ),
            field(
              '模式',
              h(
                'select',
                {
                  className: 'wfo-select',
                  value: task.agentPreset ?? '',
                  onChange: (event) => {
                    const value = event.target.value
                    updateTask(node.id, { agentPreset: value === '' ? undefined : value })
                  },
                },
                optionRows(presetRows, '使用默认模式'),
              ),
              '对应 DSH 新建任务时的 Agent 模式（默认「标准模式」）。',
            ),
            field(
              '权限',
              h(
                'select',
                {
                  className: 'wfo-select',
                  value: task.permissionPreset ?? '',
                  onChange: (event) => {
                    const value = event.target.value
                    updateTask(node.id, { permissionPreset: value === '' ? undefined : value })
                  },
                },
                optionRows(permissionRows, '使用默认权限'),
              ),
              '任务会话创建后立即应用该权限预设；默认使用完全权限。',
            ),
            field('模型', renderModelSelect(), '默认使用 DSH 当前默认模型，也可以为单个任务覆盖。'),
            isJudge
              ? field(
                  '判定为终止时',
                  h(
                    'select',
                    {
                      className: 'wfo-select',
                      value: control.stopPolicy ?? 'detach',
                      onChange: (event) => updateControl(node.id, { stopPolicy: event.target.value }),
                    },
                    STOP_POLICY_OPTIONS.map((option) =>
                      h('option', { key: option.value, value: option.value }, option.label),
                    ),
                  ),
                  STOP_POLICY_OPTIONS.find((option) => option.value === (control.stopPolicy ?? 'detach'))?.hint,
                )
              : null,
            h('div', { className: 'wfo-divider' }),
            h(
              'div',
              { className: 'wfo-run-card' },
              h(
                'div',
                { className: 'wfo-run-row' },
                h('b', null, '节点状态'),
                h('span', { className: `wfo-node-status ${state?.status ?? 'pending'}` }, NODE_STATUS_LABEL[state?.status ?? 'pending'] ?? state?.status ?? '等待中'),
              ),
              isJudge && state?.decision
                ? h(
                    'div',
                    { className: 'wfo-run-row' },
                    h('b', null, '判定结果'),
                    h('span', null, state.decision === 'STOP' ? '终止工作流' : '继续'),
                  )
                : null,
              h(
                'div',
                { className: 'wfo-run-row' },
                h('b', null, '执行范围'),
                h(
                  'span',
                  null,
                  runScope === null
                    ? '全部节点'
                    : `从「${runScope.title}」开始（跳过 ${runScope.skipped} 个节点）`,
                ),
              ),
              sessionId
                ? h(
                    'div',
                    { className: 'wfo-run-row' },
                    h('b', null, '任务会话'),
                    h('code', { title: sessionId }, sessionId),
                  )
                : h('div', { className: 'wfo-run-row' }, h('span', null, '启动工作流后，这里会显示新建的任务会话 ID。')),
              state?.error
                ? h('div', { className: 'wfo-run-row' }, h('span', { style: { color: 'var(--dsw-alias-state-error-primary,#d1453b)' } }, String(state.error)))
                : null,
              sessionId
                ? h(
                    'div',
                    { className: 'wfo-run-actions' },
                    h(
                      'button',
                      { className: 'wfo-btn small', onClick: () => openTaskSession(sessionId) },
                      '打开任务会话',
                    ),
                    h(
                      'button',
                      {
                        className: 'wfo-btn small ghost',
                        onClick: () => {
                          try {
                            void navigator.clipboard?.writeText(sessionId)
                            showNotice('info', '已复制会话 ID')
                          } catch {
                            showNotice('info', `会话 ID：${sessionId}`)
                          }
                        },
                      },
                      '复制 ID',
                    ),
                  )
                : null,
            ),
            h('div', { className: 'wfo-divider' }),
            h(
              'button',
              {
                className: 'wfo-btn danger',
                onClick: () => removeNode(node.id),
              },
              '删除节点',
            ),
          )
        }

        const renderTerminatedPill = () => {
          if (currentRun?.terminated !== true) return null
          const byTitle = currentRun.terminatedBy?.title
          const reason = typeof currentRun.terminatedReason === 'string' ? currentRun.terminatedReason : ''
          return h(
            'span',
            { className: 'wfo-pill terminated', title: reason !== '' ? reason : '工作流已提前结束' },
            `提前终止${byTitle ? `（${byTitle}）` : ''}`,
          )
        }

        const renderLog = () => {
          const entries = (currentRun?.log ?? []).filter((entry) => (entry.time ?? 0) > logClearedAt)
          const status = currentRun?.status ?? (runIsActive ? 'running' : 'idle')
          const elapsedTo = currentRun?.endedAt ?? (runIsActive ? now : null)
          const elapsed =
            currentRun?.startedAt && elapsedTo ? formatDuration(elapsedTo - currentRun.startedAt) : null
          return h(
            'div',
            { className: 'wfo-log' },
            h(
              'div',
              { className: 'wfo-log-head' },
              h('span', null, '消息窗口'),
              status === 'idle' ? null : statusPill(status),
              renderTerminatedPill(),
              elapsed ? h('span', { className: 'wfo-save-state' }, `用时 ${elapsed}`) : null,
              h('span', { className: 'wfo-grow' }),
              h(
                'button',
                {
                  className: 'wfo-btn small ghost',
                  onClick: () => setLogClearedAt(Date.now()),
                  disabled: entries.length === 0,
                  title: '仅清除当前显示的日志，不删除运行记录',
                },
                '清空显示',
              ),
            ),
            h(
              'div',
              { className: 'wfo-log-body', ref: logBodyRef },
              entries.length === 0
                ? h('div', { className: 'wfo-log-empty' }, '暂无执行日志。点击顶部「执行」后，这里会显示每个节点的启动、完成和错误信息。')
                : entries.map((entry, index) =>
                    h(
                      'div',
                      { className: 'wfo-log-row', key: `${entry.time}-${index}` },
                      h('span', { className: 'wfo-log-time' }, formatTime(entry.time)),
                      h('span', { className: `wfo-log-level ${entry.level ?? 'info'}` }, (entry.level ?? 'info').toUpperCase()),
                      entry.nodeTitle
                        ? h('span', { className: 'wfo-log-node', title: entry.nodeTitle }, entry.nodeTitle)
                        : null,
                      h('span', { className: 'wfo-log-msg' }, entry.message ?? ''),
                    ),
                  ),
            ),
          )
        }

        const renderToolbar = () => {
          const workflowOptions = workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))
          return h(
            'div',
            { className: 'wfo-toolbar' },
            h(
              'div',
              { className: 'wfo-brand' },
              h('span', { className: 'wfo-brand-mark' }, h(PanelIcon, { size: 14 })),
              h('span', null, '工作流编排'),
            ),
            h(
              'select',
              {
                className: 'wfo-select',
                value: activeWorkflowId ?? '',
                onChange: (event) => switchWorkflow(event.target.value),
                title: '切换工作流',
              },
              workflowOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
            ),
            h('input', {
              className: 'wfo-input name',
              value: activeWorkflow?.name ?? '',
              placeholder: '工作流名称',
              onChange: (event) => updateWorkflow((workflow) => ({ ...workflow, name: event.target.value })),
              title: '重命名当前工作流',
            }),
            h('button', { className: 'wfo-btn', onClick: () => void createWorkflow(), title: '新建工作流' }, '新建'),
            h('button', { className: 'wfo-btn ghost', onClick: () => void deleteWorkflow(), title: '删除当前工作流' }, '删除'),
            h('span', { className: 'wfo-grow' }),
            h(
              'span',
              { className: 'wfo-save-state' },
              saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存',
            ),
            currentRun !== null && (runIsActive || currentRun.status !== undefined)
              ? statusPill(runIsActive ? 'running' : currentRun.status)
              : null,
            renderTerminatedPill(),
            h(
              'button',
              {
                className: 'wfo-btn primary',
                onClick: () => void startRun(),
                disabled: activeWorkflow === null || runIsActive || (activeWorkflow?.nodes?.length ?? 0) === 0,
                title: '按当前编排启动工作流',
              },
              '执行',
            ),
            h(
              'button',
              {
                className: 'wfo-btn danger',
                onClick: () => setStopDialogOpen(true),
                disabled: !runIsActive,
                title: '终止正在运行的工作流',
              },
              '终止',
            ),
            h(
              'button',
              {
                className: 'wfo-btn ghost',
                title: '重新读取工作流与选项',
                onClick: () => {
                  void (async () => {
                    try {
                      await loadState()
                      showNotice('info', '已刷新')
                    } catch (error) {
                      showNotice('error', `刷新失败：${error.message}`)
                    }
                  })()
                },
              },
              '刷新',
            ),
          )
        }

        if (loading) {
          return h(
            'div',
            { className: 'wfo-root' },
            h('div', { className: 'wfo-loading' }, h('span', { className: 'wfo-spinner' }), '正在加载工作流…'),
          )
        }

        const catalogProblems = Array.isArray(catalogs?.problems) ? catalogs.problems : []
        return h(
          'div',
          { className: 'wfo-root' },
          renderToolbar(),
          notice !== null
            ? h(
                'div',
                { className: `wfo-banner ${notice.kind === 'error' ? 'error' : 'info'}` },
                h('span', { className: 'wfo-grow' }, notice.text),
                h('button', { className: 'wfo-btn small ghost', onClick: () => setNotice(null) }, '关闭'),
              )
            : null,
          activeWorkflow !== null && workspaceInfo.multi
            ? h(
                'div',
                { className: 'wfo-banner warn' },
                h(
                  'span',
                  { className: 'wfo-grow' },
                  `当前工作流跨 ${workspaceInfo.entries.length} 个工作区：${workspaceInfo.entries.map((entry) => entry.title).join('、')}。节点卡片已用不同背景色区分，可在右侧「节点工作区配色」中调整。`,
                ),
              )
            : null,
          catalogProblems.length > 0 && (catalogs?.workspaces?.length ?? 0) === 0
            ? h(
                'div',
                { className: 'wfo-banner error' },
                h('span', { className: 'wfo-grow' }, '当前没有可用工作区：请先在 DSH 左侧栏添加一个工作区，工作流任务才会出现在任务列表中。'),
              )
            : null,
          h(
            'div',
            { className: 'wfo-main' },
            renderPalette(),
            h('div', { className: 'wfo-center' }, renderCanvas(), renderLog()),
            renderInspector(),
          ),
          stopDialogOpen
            ? h(
                'div',
                { className: 'wfo-modal-mask', onClick: () => setStopDialogOpen(false) },
                h(
                  'div',
                  { className: 'wfo-modal', onClick: (event) => event.stopPropagation() },
                  h('h3', null, '终止工作流'),
                  h('p', null, '请选择终止方式：'),
                  h(
                    'div',
                    { className: 'wfo-modal-option' },
                    h(
                      'button',
                      { className: 'wfo-modal-btn', onClick: () => void stopRun(false) },
                      h('b', null, '仅停止工作流'),
                      h('span', null, '正在运行的任务继续执行完成，后续节点不再启动。'),
                    ),
                    h(
                      'button',
                      { className: 'wfo-modal-btn', onClick: () => void stopRun(true) },
                      h('b', null, '停止工作流并终止正在运行的任务'),
                      h('span', null, '同时停止当前正在运行的任务会话（相当于在工作区里点停止）。'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'wfo-modal-foot' },
                    h('button', { className: 'wfo-btn', onClick: () => setStopDialogOpen(false) }, '取消'),
                  ),
                ),
              )
            : null,
        )
      }
    }

    // ---------------------------------------------------------------------
    // plugin entry
    // ---------------------------------------------------------------------
    const inject = ['slots']

    function apply(ctx) {
      let disposeStyle = () => {}
      if (document.getElementById(STYLE_ID) === null) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        disposeStyle = () => style.remove()
      }

      const Panel = createPanel(ctx)
      ctx.effect(() => {
        const disposeMain = ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY }, Panel),
        )
        const disposePanel = ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_KEY,
              order: 40,
              label: () => '工作流编排',
            },
            PanelIcon,
          ),
        )
        return () => {
          try {
            disposeMain?.()
          } catch {
            /* declaration already gone */
          }
          try {
            disposePanel?.()
          } catch {
            /* declaration already gone */
          }
          disposeStyle()
        }
      }, 'workflow-orchestrator: slots')
    }

    return { name: 'dsh-workflow-orchestrator', inject, apply }
  },
})
