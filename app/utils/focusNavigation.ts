/**
 * 方向键焦点导航：在指定方向上找到距离当前项最近的元素索引（几何最近邻）。
 * 适用于瀑布流、网格、任意不规则布局的方向键导航。
 *
 * 距离基于元素中心点的欧氏距离，仅在该方向上有分量的候选中取最近。
 *
 * @param elements 元素数组（与选中索引一一对应）
 * @param currentIndex 当前选中索引
 * @param direction 'up' | 'down' | 'left' | 'right'
 * @returns 最近项的索引；无候选返回 -1
 */
export function findNearestInDirection(
  elements: HTMLElement[],
  currentIndex: number,
  direction: 'up' | 'down' | 'left' | 'right',
): number {
  if (elements.length === 0 || currentIndex < 0 || currentIndex >= elements.length) {
    return -1
  }
  const curEl = elements[currentIndex]
  if (!curEl) return -1
  const cur = curEl.getBoundingClientRect()
  const curCx = cur.left + cur.width / 2
  const curCy = cur.top + cur.height / 2

  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < elements.length; i++) {
    if (i === currentIndex) continue
    const el = elements[i]
    if (!el) continue
    const r = el.getBoundingClientRect()
    // 跳过不可见/未布局元素
    if (r.width === 0 && r.height === 0) continue

    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const dx = cx - curCx
    const dy = cy - curCy

    let inDirection = false
    if (direction === 'down' && dy > 0) inDirection = true
    else if (direction === 'up' && dy < 0) inDirection = true
    else if (direction === 'right' && dx > 0) inDirection = true
    else if (direction === 'left' && dx < 0) inDirection = true
    if (!inDirection) continue

    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

/**
 * 判断事件目标（或当前焦点元素）是否位于可编辑元素内。
 * 供快捷键系统做编辑态守卫：编辑中不拦截 Enter/Delete/方向键等原生行为、不执行命令，
 * 避免便签换行被吞、编辑框里误触发粘贴等问题。
 */
export function isEditingField(target?: EventTarget | null): boolean {
  const el = (target ?? (typeof document !== 'undefined' ? document.activeElement : null)) as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
