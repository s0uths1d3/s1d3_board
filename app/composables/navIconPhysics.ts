/**
 * 依赖无关的解析弹簧模型，真实交互与姿态预览共用。
 *
 * 移植自设计稿 `svg-anim/nav-physics.js`，在三处做了扩展：
 * 1. 模块边界改成 ESM；
 * 2. 新增 `reverse()`：长按进入拖拽等「这次按压被外部接管」的场景要原路退回，
 *    而不是像 release() 那样顺势把旋转补完；
 * 3. 新增「按下段闸门」（见 COMPLETION_BOOST 与 NavMotionKind）：往返型图标快点时
 *    先把按下段提速补完再回弹，否则 stage1 的形变会被吃掉。这是对设计稿
 *    「松手只改变目标、保留当前位置和速度」的有意覆盖，不是修 bug。
 *
 * 弹簧参数、错拍时序都是设计稿调好的，改动前请对照原稿。
 */

export class Spring {
  x = 0
  v = 0
  target = 0

  constructor(
    public omega = 26,
    public damping = 0.62,
  ) {}

  step(dt: number) {
    const w = this.omega
    const z = this.damping
    const y = this.x - this.target
    const decay = Math.exp(-z * w * dt)
    if (z === 1) {
      // 临界阻尼：无回弹，转向不越界
      const b = this.v + w * y
      this.x = this.target + (y + b * dt) * decay
      this.v = (this.v - w * b * dt) * decay
    } else {
      const wd = w * Math.sqrt(1 - z * z)
      const a = (this.v + z * w * y) / wd
      const c = Math.cos(wd * dt)
      const s = Math.sin(wd * dt)
      this.x = this.target + decay * (y * c + a * s)
      this.v = decay * (this.v * c - (z * w * a + y * wd) * s)
    }
  }

  get settled() {
    return Math.abs(this.x - this.target) < 0.0004 && Math.abs(this.v) < 0.008
  }
}

export interface NavPose {
  body: number
  detail: number
  angle: number
  bars: number[]
  fills: number[]
  ink: number[]
}

export type NavState = 'idle' | 'held' | 'press' | 'release' | 'preview'

export interface NavModel {
  type: string
  press(): void
  release(): void
  reverse(): void
  step(dt: number): void
  stop(): void
  readonly settled: boolean
  readonly held: boolean
  readonly time: number
  readonly state: NavState
  readonly progress: number
  readonly inputId: number
  snapshot(): NavPose
}

/**
 * 图标的运动学分类——决定松手时要不要「先补完按下段」的闸门。
 *
 * 判据是**松手后的运动会不回折**，跟图标长什么样、有几个图层都无关：
 *
 * - `reciprocate`（往返型）：松手与按下方向**相反**（压缩 → 回弹、收短 → 展开、
 *   勾线收回 → 重画）。快点时按下段还在半路就被反转，stage1 的形变永远看不到，
 *   所以要加闸门：先提速把按下段跑完，再开始回弹。
 * - `continuous`（连续型）：松手只是换一个更远的目标、**继续朝同一方向**走
 *   （预转 18°/36° → 转满 90°/360°）。这类运动本来就不回折，加闸门会变成
 *   「先停在 18° 再重新起步」的顿挫，所以必须**不加**闸门。
 *
 * 新增图标时先问一句：**松手那一刻，运动方向会翻转吗？** 会 → `reciprocate`；
 * 只是继续走完 → `continuous`。拿不准就按默认的 `reciprocate`：多补一次按下段
 * 只是稍慢，而把形变吃掉是肉眼可见的缺陷。
 *
 * 注意 `kind` 和 `rotating` 是两个独立的轴，不要合并：`rotating` 说的是
 * 「有没有转子要驱动这个姿态」，`kind` 说的是「松手会不会回折」。当前两个旋转图标
 * 恰好都是连续型，但「先绕上去、松手再弹回」的旋转图标是往返型，两者会分叉。
 */
export type NavMotionKind = 'reciprocate' | 'continuous'

/**
 * 已登记图标的分类。未登记的按 `reciprocate` 兜底。
 * 新增图标（往 `app/assets/svg/nav/` 丢 SVG）时在这里补一行。
 */
const MOTION_KIND: Record<string, NavMotionKind> = {
  // 往复回弹：需要闸门
  clip: 'reciprocate',
  todo: 'reciprocate',
  note: 'reciprocate',
  pinned: 'reciprocate',
  statistics: 'reciprocate',
  // 同向走到底：不能加闸门
  setting: 'continuous',
  app_usage: 'continuous',
}

export function motionKindOf(type: string): NavMotionKind {
  return MOTION_KIND[type] ?? 'reciprocate'
}

/**
 * 补完按下段时的临时刚度倍数。
 *
 * 快点时按下段只跑了一半，若原地反转，stage1 的形变就白做了。进入闸门后把
 * `active` 里所有弹簧的刚度乘上这个倍数（阻尼值不动，回弹的性格保持不变），
 * 到位后立刻恢复原值开始回弹。按 VISUAL_ARRIVAL 出口实测：无错拍的图标
 * 松手后 ~75ms 补完，带错拍的统计 ~125ms。这是手感旋钮：调大更"啪"、调小更柔和。
 */
const COMPLETION_BOOST = 1.9

/**
 * 闸门出口用的「看起来已经到位」阈值，是弹簧值的容差（0..1），不是像素。
 *
 * 不要拿 `Spring.settled` 当出口。它的 epsilon（|x-target| < 0.0004 且 |v| < 0.008）
 * 是为「rAF 循环能不能停」定的，严得多；用它当出口，弹簧 ~75ms 就摆到了满压姿态，
 * 却要静止等到 ~240ms 速度才衰减够——中间那 130~190ms 图标一动不动，实测就是这么顿的。
 *
 * 2% 远小于任何可见量级：body 的 2% 是 0.06% 缩放、图钉的 2% 是 0.04px、
 * 墨迹线的 2% 是 0.07px，可以放心当作"已到位"。各弹簧都从 0 单调升向 1
 * （阻尼 0.82~1，最大超调约 1.1%），越过 2% 后只会更贴近目标、不会来回穿越，
 * 所以只判位置即可，不必再加速度条件。
 */
const VISUAL_ARRIVAL = 0.02

/**
 * 未在下面的 switch/白名单里出现的图标名也安全：拿不到 ink/柱条/旋转，
 * 只保留 body + detail 的整体压缩（并且按 `reciprocate` 走闸门，正好对）。
 * 往 assets/svg/nav/ 丢新图标即可受益。
 */
export function createModel(type: string = ''): NavModel {
  const body = new Spring(30, 0.64)
  const detail = new Spring(type === 'pinned' ? 25 : 28, 0.55)
  const bars = [new Spring(26, 0.46), new Spring(25, 0.48), new Spring(24, 0.5)]
  const fills = [new Spring(23, 1), new Spring(23, 1), new Spring(23, 1)]
  // 角度用临界阻尼：只朝前走、不回弹；body / detail 才负责弹性
  const rotor = new Spring(type === 'setting' ? 13 : 17, 1)
  const turn = type === 'setting' ? 90 : 360
  const anticipation = type === 'setting' ? 18 : 36
  const ink = [new Spring(25, 0.62), new Spring(23, 0.64)]
  const hasInk = ['note', 'todo', 'clip'].includes(type)
  const rotating = type === 'setting' || type === 'app_usage'
  const active = [
    body,
    detail,
    ...(hasInk ? ink : []),
    ...(type === 'statistics' ? [...bars, ...fills] : []),
    ...(rotating ? [rotor] : []),
  ]

  const kind = motionKindOf(type)
  /** 闸门提速前的原始刚度，用于恢复。转子只在连续型出现，而连续型不走闸门 */
  const baseOmegas = active.map(s => s.omega)

  let time = 0
  let held = false
  let end = 0
  let events: { at: number; action: () => void }[] = []
  let releaseAt = 0
  let activeSince = 0
  let inputId = 0
  /** 本次按压已加过 turn、且尚未被 release 补完——reverse() 只在这种状态下撤销旋转 */
  let pendingTurn = false
  /** 闸门挂起中：已松手，但按下段还没到位，等 step() 把它补完再回弹 */
  let pendingRelease = false

  function schedule(delay: number, action: () => void) {
    events.push({ at: time + delay, action })
    events.sort((a, b) => a.at - b.at)
  }

  function moveTargets(down: boolean) {
    body.target = detail.target = down ? 1 : 0
    body.damping = down ? 0.9 : 0.64
    detail.damping = down ? 0.82 : type === 'pinned' ? 0.46 : 0.55
    if (hasInk) {
      ink.forEach((line, i) => {
        schedule(type === 'todo' ? 0 : i * 0.035, () => {
          line.target = down ? 1 : 0
          // 便签的文字是弹性长度：勾线方向的单调性由 todo 的阻尼 1 保证
          line.damping = type === 'todo' ? 1 : down ? 0.86 : 0.62 + i * 0.02
          if (down) line.v = Math.min(8, line.v + 5)
        })
      })
    }
    if (type === 'statistics') {
      bars.forEach((bar, i) => {
        schedule(i * 0.024, () => {
          bar.target = down ? 1 : 0
          bar.damping = down ? 0.87 : 0.46 + i * 0.02
          if (down) bar.v = Math.min(8, bar.v + 5)
          fills[i]!.target = down ? 1 : 0
        })
      })
    }
  }

  /**
   * 按下段（stage1）是否已经「看得出来」到位了——闸门出口，见 VISUAL_ARRIVAL。
   *
   * 必须连 `target === 1` 一起判：错拍的 ink / 柱条要等各自的 schedule 事件触发
   * 才会把目标改成 1，在那之前它们的 x 和 target 都是 0、位置差为 0，会被误判成
   * "已到位"，导致目标在后面才被改成 1，出现"别的图层在回弹、它却还在压下去"的错乱。
   */
  function stageOneArrived() {
    return active.every(s => s.target === 1 && Math.abs(s.x - 1) <= VISUAL_ARRIVAL)
  }

  /** 只调刚度做提速，阻尼不动，回弹的性格才不会被闸门改掉 */
  function setCompletionBoost(on: boolean) {
    active.forEach((s, i) => {
      s.omega = baseOmegas[i]! * (on ? COMPLETION_BOOST : 1)
    })
  }

  /** 真正开始回弹（stage2）：恢复刚度、反转目标、旋转类补到 end */
  function finishRelease() {
    pendingRelease = false
    setCompletionBoost(false)
    moveTargets(false)
    if (rotating) {
      rotor.target = end
      pendingTurn = false
    }
  }

  const model: NavModel = {
    type,
    press() {
      if (held) return
      held = true
      inputId++
      activeSince = time
      // 再次按下立即接管：正在挂起的回弹闸门直接作废，不排队、不重置位置
      pendingRelease = false
      // 输入只补一点初速度；重设目标从不重置位置，所以连点能随时接上
      body.v = Math.min(8, body.v + 5)
      detail.v = Math.min(8, detail.v + 5)
      moveTargets(true)
      if (rotating) {
        end += turn
        rotor.target = end - turn + anticipation
        // 快速再按时不能把目标选到转子当前姿态之后
        rotor.target = Math.max(rotor.x, rotor.target)
        pendingTurn = true
      }
    },
    release() {
      if (!held) return
      held = false
      releaseAt = time
      // 往返型图标快点时，按下段还在半路。若在这里直接反转目标，stage1 的形变
      // 会被永久吃掉（设计稿的 play() 注释也承认了这点）。于是先把闸门挂起，
      // 提速把按下段跑完，再由 step() 接着回弹。
      // 连续型不能走这条路：它的"按下段"是预转角，停下来等它到位会顿一下。
      if (kind === 'reciprocate' && !stageOneArrived()) {
        pendingRelease = true
        setCompletionBoost(true)
        return
      }
      finishRelease()
    },
    /**
     * 反向回到起点：撤销本次按压的进行量。
     * 与 release() 的唯一区别在旋转类图标——release 补到 end（完成），
     * reverse 把 end 退回本次的 turn，齿轮/指针沿原路转回，落回等价姿态。
     */
    reverse() {
      held = false
      releaseAt = time
      // 闸门必须让路：拖拽要的是原路退回，不是先把按下段补完
      pendingRelease = false
      setCompletionBoost(false)
      moveTargets(false)
      if (rotating && pendingTurn) {
        end -= turn
        rotor.target = end
        pendingTurn = false
      }
    },
    step(dt: number) {
      // 精确切到事件边界：错拍时序与帧率无关
      const finish = time + Math.max(0, dt)
      while (events.length && events[0]!.at <= finish + 1e-10) {
        const event = events.shift()!
        const slice = Math.max(0, event.at - time)
        active.forEach(s => s.step(slice))
        time = event.at
        event.action()
      }
      active.forEach(s => s.step(Math.max(0, finish - time)))
      time = finish
      // 闸门出口：按下段一到位就立刻接上回弹，不必等下一次输入
      if (pendingRelease && stageOneArrived()) finishRelease()
    },
    get settled() {
      return events.length === 0 && active.every(s => s.settled)
    },
    get held() {
      return held
    },
    get time() {
      return time
    },
    get state(): NavState {
      if (held) return model.settled ? 'held' : 'press'
      return model.settled ? 'idle' : 'release'
    },
    get progress() {
      if (model.settled && !held) return 0
      return held
        ? Math.min(0.2, (time - activeSince) / 0.6)
        : Math.min(0.99, 0.2 + (time - releaseAt) / 0.9)
    },
    get inputId() {
      return inputId
    },
    stop() {
      held = false
      events = []
      end = 0
      pendingTurn = false
      pendingRelease = false
      setCompletionBoost(false)
      ;[...active, rotor].forEach(s => {
        s.x = s.v = s.target = 0
      })
    },
    snapshot() {
      return {
        body: body.x,
        detail: detail.x,
        angle: rotor.x,
        bars: bars.map(s => s.x),
        fills: fills.map(s => s.x),
        ink: ink.map(s => s.x),
      }
    },
  }
  return model
}
