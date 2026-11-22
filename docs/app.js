/* Agent Flight Recorder — local timeline viewer (no network required once loaded). */
(function () {
  const fileInput = document.getElementById('file');
  const demoBtn = document.getElementById('demo-btn');
  const treeList = document.getElementById('tree-list');
  const timeline = document.getElementById('timeline');
  const meta = document.getElementById('meta');
  const detailEmpty = document.getElementById('detail-empty');
  const detailBody = document.getElementById('detail-body');
  let current = null;
  let selectedId = null;

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    loadTrace(JSON.parse(text));
  });

  demoBtn.addEventListener('click', () => {
    if (window.AFR_TRACE) {
      loadTrace(window.AFR_TRACE);
      return;
    }
    fetch('./trace.json')
      .then((res) => {
        if (!res.ok) throw new Error('No demo trace is bundled next to this page.');
        return res.json();
      })
      .then(loadTrace)
      .catch((error) => {
        detailEmpty.hidden = false;
        detailEmpty.textContent = error.message;
      });
  });

  if (window.AFR_TRACE) {
    loadTrace(window.AFR_TRACE);
  } else {
    fetch('./trace.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((trace) => {
        if (trace) loadTrace(trace);
      })
      .catch(() => {});
  }

  function loadTrace(trace) {
    current = trace;
    selectedId = null;
    renderMeta(trace);
    renderTree(trace);
    renderTimeline(trace);
    detailBody.hidden = true;
    detailEmpty.hidden = false;
    detailEmpty.textContent = 'Select a span in the tree or timeline.';
  }

  function renderMeta(trace) {
    meta.hidden = false;
    document.getElementById('run-sub').textContent =
      `${trace.run.name} · ${trace.run.id.slice(0, 8)}…`;
    document.getElementById('meta-name').textContent = trace.run.name;
    const status = document.getElementById('meta-status');
    status.textContent = trace.run.status;
    status.className = `pill ${trace.run.status === 'ERROR' ? 'error' : 'ok'}`;
    document.getElementById('meta-spans').textContent = String(trace.spans.length);
    const agents = new Set(
      trace.spans
        .filter((s) => s.attributes && s.attributes['afr.span.type'] === 'agent')
        .map((s) => s.attributes['afr.agent.id'] || s.name),
    );
    document.getElementById('meta-agents').textContent = String(agents.size);
    const red = document.getElementById('meta-redaction');
    if (trace.redaction && trace.redaction.applied) {
      red.textContent = `${trace.redaction.redactedCount} hits`;
      red.className = 'pill warn';
      red.title = (trace.redaction.rulesTriggered || []).join(', ');
    } else {
      red.textContent = 'not applied';
      red.className = 'pill';
    }
  }

  function typeOf(span) {
    return (span.attributes && span.attributes['afr.span.type']) || 'span';
  }

  function renderTree(trace) {
    treeList.innerHTML = '';
    const byParent = new Map();
    for (const span of trace.spans) {
      const key = span.parentSpanId || '';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(span);
    }
    const roots = byParent.get('') || trace.spans.filter((s) => !s.parentSpanId);
    const walk = (span, depth) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'span-btn';
      btn.dataset.spanId = span.spanId;
      const type = typeOf(span);
      const label = span.name.replace(/^(agent|llm|decision|run):/, '');
      btn.innerHTML = `${'<span class="indent"></span>'.repeat(depth)}<span class="type ${type}">${escapeHtml(type)}</span> ${escapeHtml(label)}`;
      btn.addEventListener('click', () => selectSpan(span.spanId));
      li.appendChild(btn);
      treeList.appendChild(li);
      for (const child of byParent.get(span.spanId) || []) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);
  }

  function renderTimeline(trace) {
    timeline.innerHTML = '';
    const times = trace.spans.map((s) => Number(s.startTimeUnixNano));
    const ends = trace.spans.map((s) => Number(s.endTimeUnixNano || s.startTimeUnixNano));
    const min = Math.min(...times);
    const max = Math.max(...ends, min + 1);
    const range = Math.max(max - min, 1);

    const lanes = new Map();
    for (const span of trace.spans) {
      const type = typeOf(span);
      const laneKey =
        type === 'run' ? 'run' : (span.attributes && span.attributes['afr.agent.id']) || type;
      if (!lanes.has(laneKey)) lanes.set(laneKey, []);
      lanes.get(laneKey).push(span);
    }

    for (const [name, spans] of lanes) {
      const lane = document.createElement('div');
      lane.className = 'lane';
      const label = document.createElement('div');
      label.className = 'lane-label';
      label.textContent = name;
      const track = document.createElement('div');
      track.className = 'lane-track';
      for (const span of spans) {
        const start = Number(span.startTimeUnixNano);
        const end = Number(span.endTimeUnixNano || span.startTimeUnixNano);
        const left = ((start - min) / range) * 100;
        const width = Math.max(((end - start) / range) * 100, 1.2);
        const bar = document.createElement('button');
        bar.type = 'button';
        bar.className = `bar ${typeOf(span)}${span.status && span.status.code === 'ERROR' ? ' error' : ''}`;
        bar.style.left = `${left}%`;
        bar.style.width = `${width}%`;
        bar.textContent = span.name.replace(/^(agent|llm|decision):/, '');
        bar.title = span.name;
        bar.dataset.spanId = span.spanId;
        bar.addEventListener('click', () => selectSpan(span.spanId));
        track.appendChild(bar);
      }
      lane.appendChild(label);
      lane.appendChild(track);
      timeline.appendChild(lane);
    }
  }

  function selectSpan(id) {
    selectedId = id;
    document.querySelectorAll('[data-span-id]').forEach((el) => {
      el.classList.toggle('active', el.dataset.spanId === id);
    });
    const span = current && current.spans.find((s) => s.spanId === id);
    if (!span) return;
    detailEmpty.hidden = true;
    detailBody.hidden = false;
    const attrs = Object.entries(span.attributes || {})
      .map(
        ([k, v]) =>
          `<tr><th>${escapeHtml(k)}</th><td class="${isRedacted(v) ? 'redacted' : ''}">${escapeHtml(fmt(v))}</td></tr>`,
      )
      .join('');
    const messages = (span.events || [])
      .filter((e) => e.name === 'afr.message')
      .map((e) => {
        const role = (e.attributes && e.attributes['afr.message.role']) || 'message';
        const content = (e.attributes && e.attributes['afr.message.content']) || '';
        return `<div class="msg"><div class="role">${escapeHtml(role)}</div><div class="${isRedacted(content) ? 'redacted' : ''}">${escapeHtml(String(content))}</div></div>`;
      })
      .join('');
    const links = (span.links || [])
      .map(
        (l) =>
          `<tr><th>${escapeHtml((l.attributes && l.attributes['afr.link.type']) || 'link')}</th><td>${escapeHtml(l.spanId)}</td></tr>`,
      )
      .join('');
    detailBody.innerHTML = `
      <h3>${escapeHtml(span.name)}</h3>
      <table class="kv">
        <tr><th>span id</th><td>${escapeHtml(span.spanId)}</td></tr>
        <tr><th>status</th><td>${escapeHtml(span.status.code)}${span.status.message ? ' — ' + escapeHtml(span.status.message) : ''}</td></tr>
        ${attrs}
        ${links}
      </table>
      ${messages ? `<div class="messages">${messages}</div>` : ''}
    `;
  }

  function isRedacted(value) {
    return typeof value === 'string' && value.includes('[REDACTED:');
  }

  function fmt(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
