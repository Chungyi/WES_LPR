// 即時辨識用的車牌追蹤：把連續多張畫面的辨識結果對應到同一個車牌，再用投票決定文字，
// 讓畫面上的標籤穩定、不會每一張畫面都跳來跳去。

const DEFAULTS = {
  iouThreshold: 0.2,   // 框的重疊比例超過這個值，視為同一個車牌
  maxMisses: 2,        // 連續幾張畫面沒看到，就移除（車牌離開畫面後標籤很快消失）
  maxAgeMs: 1000,      // 超過這個時間沒再看到，也移除（辨識較慢的手機）
  minHits: 2,          // 至少看到幾次才顯示（單次信心很高時例外）
  instantConfidence: 0.8, // 單次信心達到這個值就立刻顯示
  smoothing: 0.7,      // 新位置的權重：越大框跟得越緊，越小移動越平順
};

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

function centerDistance(a, b) {
  const dx = (a.x1 + a.x2) / 2 - (b.x1 + b.x2) / 2;
  const dy = (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2;
  return Math.hypot(dx, dy);
}

export class PlateTracker {
  constructor(options = {}) {
    this.opt = { ...DEFAULTS, ...options };
    this.tracks = [];
    this.nextId = 1;
  }

  reset() {
    this.tracks = [];
  }

  /** 加入一張畫面的辨識結果：[{ box, text, confidence }] */
  update(detections, now = performance.now()) {
    const free = new Set(this.tracks);
    const dets = detections.filter((d) => d.text).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    for (const det of dets) {
      let best = null;
      let bestIou = this.opt.iouThreshold;
      for (const t of free) {
        const v = iou(t.box, det.box);
        if (v >= bestIou) {
          best = t;
          bestIou = v;
        }
      }
      // 手機移動較快、框沒有重疊時：文字相同且距離不遠，也視為同一個車牌
      if (!best) {
        const w = det.box.x2 - det.box.x1;
        for (const t of free) {
          if (t.text === det.text && centerDistance(t.box, det.box) < w * 1.5) {
            best = t;
            break;
          }
        }
      }
      if (best) {
        free.delete(best);
        this.#hit(best, det, now);
      } else {
        const t = { id: this.nextId++, box: { ...det.box }, votes: new Map(), hits: 0, text: '', confidence: 0 };
        this.#hit(t, det, now);
        this.tracks.push(t);
      }
    }

    for (const t of free) t.misses += 1;
    this.tracks = this.tracks.filter((t) => t.misses < this.opt.maxMisses && now - t.lastSeen <= this.opt.maxAgeMs);
  }

  #hit(t, det, now) {
    const k = this.opt.smoothing;
    if (t.hits > 0) {
      for (const key of ['x1', 'y1', 'x2', 'y2']) t.box[key] = t.box[key] * (1 - k) + det.box[key] * k;
    }
    const weight = Math.max(0.05, det.confidence ?? 0);
    t.votes.set(det.text, (t.votes.get(det.text) ?? 0) + weight);
    t.hits += 1;
    t.misses = 0;
    t.lastSeen = now;
    t.lastConfidence = det.confidence ?? 0;

    // 票數最高的文字；同票時保留目前的文字，避免來回跳動
    let bestText = t.text;
    let bestVotes = t.votes.get(t.text) ?? -1;
    for (const [text, v] of t.votes) {
      if (v > bestVotes) {
        bestText = text;
        bestVotes = v;
      }
    }
    t.text = bestText;
    t.confidence = bestVotes / t.hits;
  }

  /** 可以顯示在畫面上的車牌；showNow(track) 為 true 的也立刻顯示（例如名單中完全相符的車牌） */
  visible(showNow) {
    return this.tracks.filter(
      (t) => t.hits >= this.opt.minHits || t.lastConfidence >= this.opt.instantConfidence || showNow?.(t)
    );
  }
}
