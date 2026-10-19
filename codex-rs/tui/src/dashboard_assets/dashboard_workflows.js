'use strict';

(() => {
  const STORAGE_KEY = 'elpis-workflow-draft-v1';
  const KINDS = ['explore', 'implement', 'verify', 'fix'];
  const WRITE_KINDS = ['implement', 'fix'];
  const NODE_WIDTH = 216;
  const NODE_HEIGHT = 94;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function initialize() {
    const panel = document.getElementById('panel-workflows');
    if (!panel || panel.dataset.editorInitialized) return;
    panel.dataset.editorInitialized = 'true';
    let draft = { name: '', max_concurrency: 2, tasks: [] };
    let positions = [];
    let selected = -1;

    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const button = (id, text, action) => {
      const element = node('button', 'btn btn-sm', text);
      element.id = id;
      element.type = 'button';
      element.addEventListener('click', action);
      return element;
    };
    const field = (parent, label, id, element) => {
      const wrapper = node('div', 'fieldset min-w-0');
      const caption = node('label', 'label text-base-content/75!', label);
      caption.htmlFor = id;
      element.id = id;
      wrapper.append(caption, element);
      parent.append(wrapper);
      return element;
    };
    const lines = value => value.split('\n').map(line => line.trim()).filter(Boolean);
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const nonempty = value => typeof value === 'string' && value.trim().length > 0;

    function validate(value) {
      const errors = [];
      if (!isObject(value)) return ['The draft must be a JSON object.'];
      if (!nonempty(value.name)) errors.push('Give the workflow a name.');
      if (value.max_concurrency !== undefined && (!Number.isInteger(value.max_concurrency) || value.max_concurrency < 1)) errors.push('Maximum concurrency must be a positive whole number.');
      if (value.max_runtime_seconds !== undefined && (!Number.isInteger(value.max_runtime_seconds) || value.max_runtime_seconds < 1)) errors.push('Maximum runtime must be a positive whole number.');
      if (!Array.isArray(value.tasks)) return [...errors, 'Tasks must be an array.'];
      if (!value.tasks.length) errors.push('Add at least one task.');
      const ids = new Set();
      value.tasks.forEach((task, index) => {
        const label = `Task ${index + 1}`;
        if (!isObject(task)) { errors.push(`${label} must be an object.`); return; }
        if (typeof task.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(task.id)) errors.push(`${label}: ID must use letters, numbers, hyphens, or underscores.`);
        else if (ids.has(task.id)) errors.push(`Duplicate task ID: ${task.id}.`);
        else ids.add(task.id);
        if (!nonempty(task.title)) errors.push(`${label}: add a title.`);
        if (!nonempty(task.instruction)) errors.push(`${label}: add an instruction.`);
        if (!KINDS.includes(task.kind)) errors.push(`${label}: choose a supported task kind.`);
        for (const key of ['depends_on', 'write_scopes', 'acceptance_criteria']) {
          if (!Array.isArray(task[key]) || task[key].some(item => !nonempty(item))) errors.push(`${label}: ${key} must be an array of nonempty strings.`);
        }
        if (Array.isArray(task.acceptance_criteria) && !task.acceptance_criteria.length) errors.push(`${label}: add at least one acceptance criterion.`);
        if (Array.isArray(task.write_scopes)) {
          if (WRITE_KINDS.includes(task.kind) && !task.write_scopes.length) errors.push(`${label}: write tasks need a write scope.`);
          if (['explore', 'verify'].includes(task.kind) && task.write_scopes.length) errors.push(`${label}: read-only tasks must have no write scopes.`);
          if (task.write_scopes.some(scope => typeof scope === 'string' && (scope.startsWith('/') || scope.split('/').includes('..')))) errors.push(`${label}: write scopes must stay within repository-relative directories.`);
        }
        if (task.environment_id !== undefined && !nonempty(task.environment_id)) errors.push(`${label}: environment_id must be a nonempty string when provided.`);
      });
      const tasks = value.tasks.filter(isObject);
      tasks.forEach(task => {
        if (!Array.isArray(task.depends_on)) return;
        if (new Set(task.depends_on).size !== task.depends_on.length) errors.push(`${task.id}: dependencies must not repeat.`);
        task.depends_on.forEach(id => { if (!ids.has(id)) errors.push(`${task.id}: unknown dependency ${String(id)}.`); });
        if (WRITE_KINDS.includes(task.kind) && !tasks.some(candidate => candidate.kind === 'verify' && candidate.environment_id === task.environment_id && Array.isArray(candidate.depends_on) && candidate.depends_on.includes(task.id))) {
          errors.push(`${task.id}: add a verify task in the same environment that directly depends on it.`);
        }
      });
      const visiting = new Set();
      const visited = new Set();
      const byId = new Map(tasks.map(task => [task.id, task]));
      function hasCycle(id) {
        if (visiting.has(id)) return true;
        if (visited.has(id) || !byId.has(id)) return false;
        visiting.add(id);
        const dependencies = byId.get(id).depends_on;
        if (Array.isArray(dependencies) && dependencies.some(hasCycle)) return true;
        visiting.delete(id);
        visited.add(id);
        return false;
      }
      if (tasks.some(task => hasCycle(task.id))) errors.push('Dependencies contain a cycle. Remove a dependency before exporting.');
      return errors;
    }

    // Export the tool argument schema only; canvas positions remain local UI state.
    function argumentsFor(value) {
      const result = { name: value.name, tasks: value.tasks.map(task => {
        const result = {};
        for (const key of ['id', 'title', 'instruction', 'kind', 'depends_on', 'write_scopes', 'acceptance_criteria']) result[key] = task[key];
        if (task.environment_id !== undefined) result.environment_id = task.environment_id;
        return result;
      }) };
      if (value.max_concurrency !== undefined) result.max_concurrency = value.max_concurrency;
      if (value.max_runtime_seconds !== undefined) result.max_runtime_seconds = value.max_runtime_seconds;
      return result;
    }

    const heading = node('header', 'panel-heading');
    const headingText = node('div');
    headingText.append(node('h2', '', 'Workflow draft'));
    heading.append(headingText, node('span', 'badge badge-outline', 'Draft — no agents running'));
    const intro = node('p', 'm-0 text-sm model-help', 'Define tasks and their dependencies. This editor saves a local draft and exports tool arguments; it does not start agents.');
    const settings = node('div', 'grid grid-cols-1 gap-4 sm:grid-cols-2');
    const nameInput = field(settings, 'Workflow name', 'workflow-name', node('input', 'input w-full'));
    const concurrencyInput = field(settings, 'Maximum concurrency', 'workflow-concurrency', node('input', 'input w-full'));
    concurrencyInput.type = 'number';
    concurrencyInput.min = '1';
    concurrencyInput.step = '1';
    concurrencyInput.value = String(draft.max_concurrency);
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; renderValidation(); });
    concurrencyInput.addEventListener('input', () => { draft.max_concurrency = concurrencyInput.value === '' ? null : Number(concurrencyInput.value); renderValidation(); });
    const actions = node('div', 'flex flex-wrap gap-2');
    const notice = node('p', 'm-0 text-sm', 'The empty draft has not been saved.');
    notice.id = 'workflow-feedback';
    notice.setAttribute('role', 'status');
    const validation = node('div', 'alert alert-soft');
    validation.id = 'workflow-validation';
    validation.setAttribute('aria-live', 'polite');
    const validationList = node('ul', 'm-0 list-disc pl-5 text-sm');
    validation.append(validationList);
    const layout = node('div', 'grid grid-cols-1 gap-4 xl:grid-cols-2');
    const left = node('article', 'card surface-card min-w-0');
    const leftBody = node('div', 'card-body compact-card-body');
    const taskList = node('div', 'flex flex-wrap gap-2');
    taskList.id = 'workflow-task-list';
    taskList.setAttribute('aria-label', 'Tasks in this draft');
    const editor = node('div', 'flex flex-col gap-3');
    editor.id = 'workflow-task-editor';
    leftBody.append(node('h3', 'card-title text-base', 'Tasks'), taskList, editor);
    left.append(leftBody);
    const right = node('article', 'card surface-card min-w-0');
    const rightBody = node('div', 'card-body compact-card-body');
    const canvasViewport = node('div', 'overflow-auto rounded-box border border-base-content/15');
    canvasViewport.style.maxHeight = '600px';
    const canvas = node('div', 'bg-base-200');
    canvas.id = 'workflow-canvas';
    canvas.style.position = 'relative';
    canvas.style.minWidth = '740px';
    canvas.style.height = '280px';
    canvas.setAttribute('aria-label', 'Draft task dependency canvas');
    const edges = document.createElementNS(SVG_NS, 'svg');
    edges.style.position = 'absolute';
    edges.style.inset = '0';
    edges.style.width = '100%';
    edges.style.height = '100%';
    edges.style.pointerEvents = 'none';
    edges.setAttribute('aria-hidden', 'true');
    canvasViewport.append(canvas);
    rightBody.append(node('h3', 'card-title text-base', 'Dependencies'), node('p', 'm-0 text-sm model-help', 'Drag a card to arrange it. Select it to edit. Focus a card and use Alt + arrow keys to move it. Lines show only the dependencies you define.'), canvasViewport);
    right.append(rightBody);
    layout.append(left, right);
    const importDetails = node('details', 'card surface-card');
    const importSummary = node('summary', 'cursor-pointer p-5 font-medium', 'Import a workflow draft');
    const importBody = node('div', 'card-body compact-card-body');
    const importInput = field(importBody, 'Workflow JSON', 'workflow-import-json', node('textarea', 'textarea w-full font-mono text-xs'));
    importInput.rows = 8;
    importInput.spellcheck = false;
    importBody.append(button('workflow-import', 'Import JSON', importDraft));
    importDetails.append(importSummary, importBody);
    actions.append(button('workflow-add-task', 'Add task', addTask), button('workflow-save', 'Save in this browser', saveDraft), button('workflow-reload', 'Reload saved draft', reloadDraft), button('workflow-export', 'Export JSON', exportDraft), button('workflow-copy', 'Copy JSON', copyDraft));
    panel.replaceChildren(heading, intro, settings, actions, notice, validation, layout, importDetails);

    function report(message, failed = false) {
      notice.textContent = message;
      notice.className = failed ? 'm-0 text-sm text-error' : 'm-0 text-sm';
    }
    function renderValidation() {
      const errors = validate(draft);
      validation.className = 'alert alert-soft ' + (errors.length ? 'alert-warning' : 'alert-success');
      validationList.replaceChildren(...(errors.length ? errors : ['Draft is valid for export. No agents have been started.']).map(error => node('li', '', error)));
      return errors;
    }
    function addTask() {
      let number = draft.tasks.length + 1;
      while (draft.tasks.some(task => task.id === `task_${number}`)) number++;
      draft.tasks.push({ id: `task_${number}`, title: '', instruction: '', kind: 'explore', depends_on: [], write_scopes: [], acceptance_criteria: [] });
      positions.push(defaultPosition(draft.tasks.length - 1));
      selected = draft.tasks.length - 1;
      refresh(true);
      document.getElementById('workflow-task-title').focus();
    }
    function selectTask(index) { selected = index; refresh(true); }
    function removeTask() {
      if (selected < 0) return;
      const [removed] = draft.tasks.splice(selected, 1);
      positions.splice(selected, 1);
      draft.tasks.forEach(task => { task.depends_on = task.depends_on.filter(id => id !== removed.id); });
      selected = Math.min(selected, draft.tasks.length - 1);
      refresh(true);
      report(`Deleted ${removed.id || 'the task'} and its dependency references. Save to keep this change.`);
    }
    function renderEditor() {
      editor.replaceChildren();
      const task = draft.tasks[selected];
      if (!task) { editor.append(node('p', 'empty-state', 'No tasks yet. Add a task to begin.')); return; }
      const textField = (label, key, multiline = false) => {
        const input = node(multiline ? 'textarea' : 'input', (multiline ? 'textarea' : 'input') + ' w-full');
        if (multiline) input.rows = key === 'instruction' ? 5 : 3;
        const array = ['write_scopes', 'acceptance_criteria'].includes(key);
        input.value = array ? task[key].join('\n') : task[key];
        input.addEventListener('input', () => {
          const previous = task.id;
          task[key] = array ? lines(input.value) : input.value;
          if (key === 'id' && previous && !draft.tasks.some(other => other !== task && other.id === previous)) {
            draft.tasks.forEach(other => { other.depends_on = other.depends_on.map(id => id === previous ? task.id : id); });
          }
          refresh(false);
        });
        field(editor, label, `workflow-task-${key.replaceAll('_', '-')}`, input);
      };
      textField('Task ID', 'id');
      textField('Title', 'title');
      const kind = field(editor, 'Task kind', 'workflow-task-kind', node('select', 'select w-full'));
      KINDS.forEach(value => { const option = node('option', '', value); option.value = value; kind.append(option); });
      kind.value = task.kind;
      kind.addEventListener('change', () => { task.kind = kind.value; refresh(false); });
      textField('Instruction', 'instruction', true);
      textField('Write scopes — one repository directory per line', 'write_scopes', true);
      textField('Acceptance criteria — one per line', 'acceptance_criteria', true);
      const environment = field(editor, 'Environment ID (optional)', 'workflow-task-environment', node('input', 'input w-full'));
      environment.value = task.environment_id || '';
      environment.addEventListener('input', () => { if (environment.value.trim()) task.environment_id = environment.value.trim(); else delete task.environment_id; renderValidation(); });
      const dependencies = node('fieldset', 'fieldset');
      dependencies.id = 'workflow-dependencies';
      dependencies.append(node('legend', 'fieldset-legend', 'Depends on'));
      editor.append(dependencies);
      renderDependencies();
      editor.append(button('workflow-delete-task', 'Delete task', removeTask));
    }
    function renderDependencies() {
      const parent = document.getElementById('workflow-dependencies');
      const task = draft.tasks[selected];
      if (!parent || !task) return;
      while (parent.children.length > 1) parent.lastElementChild.remove();
      const candidates = draft.tasks.filter(other => other !== task);
      if (!candidates.length) parent.append(node('p', 'm-0 text-sm model-help', 'Add another task to define a dependency.'));
      candidates.forEach(other => {
        const label = node('label', 'flex items-center gap-2 text-sm');
        const checkbox = node('input', 'checkbox checkbox-sm');
        checkbox.type = 'checkbox';
        checkbox.checked = task.depends_on.includes(other.id);
        checkbox.addEventListener('change', () => {
          task.depends_on = checkbox.checked ? [...new Set([...task.depends_on, other.id])] : task.depends_on.filter(id => id !== other.id);
          refresh(false);
        });
        label.append(checkbox, node('span', '', `${other.id || 'ID missing'} — ${other.title || 'Untitled task'}`));
        parent.append(label);
      });
    }
    function defaultPosition(index) { return { x: 24 + (index % 3) * 240, y: 24 + Math.floor(index / 3) * 126 }; }
    function sizeCanvas() {
      canvas.style.width = Math.max(740, ...positions.map(position => position.x + NODE_WIDTH + 24)) + 'px';
      canvas.style.height = Math.max(280, ...positions.map(position => position.y + NODE_HEIGHT + 24)) + 'px';
    }
    function svg(tag, attributes) {
      const element = document.createElementNS(SVG_NS, tag);
      Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
      return element;
    }
    function renderEdges() {
      const definitions = svg('defs', {});
      const marker = svg('marker', { id: 'workflow-dependency-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--color-base-content)' }));
      definitions.append(marker);
      edges.replaceChildren(definitions);
      draft.tasks.forEach((task, index) => {
        task.depends_on.forEach(id => {
          const predecessor = draft.tasks.findIndex(other => other.id === id);
          if (predecessor < 0) return;
          const from = positions[predecessor], to = positions[index];
          const x1 = from.x + NODE_WIDTH, y1 = from.y + NODE_HEIGHT / 2;
          const x2 = to.x - 5, y2 = to.y + NODE_HEIGHT / 2;
          const bend = Math.max(40, Math.abs(x2 - x1) / 2);
          const edge = svg('path', { d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`, fill: 'none', stroke: 'var(--color-base-content)', 'stroke-width': 1.5, opacity: 0.55, 'marker-end': 'url(#workflow-dependency-arrow)' });
          edge.dataset.from = id;
          edge.dataset.to = task.id;
          edges.append(edge);
        });
      });
    }
    function renderCanvas() {
      canvas.replaceChildren(edges);
      if (!draft.tasks.length) canvas.append(node('p', 'p-6 text-sm model-help', 'Your tasks and dependencies will appear here.'));
      draft.tasks.forEach((task, index) => {
        positions[index] ||= defaultPosition(index);
        const card = node('button', 'card border border-base-content/20 bg-base-100 p-3 text-left');
        card.type = 'button';
        card.dataset.taskId = task.id;
        card.setAttribute('aria-label', `Edit ${task.id || 'task'}: ${task.title || 'Untitled task'}`);
        card.setAttribute('aria-pressed', String(index === selected));
        Object.assign(card.style, { position: 'absolute', left: positions[index].x + 'px', top: positions[index].y + 'px', width: NODE_WIDTH + 'px', height: NODE_HEIGHT + 'px', cursor: 'grab', touchAction: 'none', overflow: 'hidden' });
        if (index === selected) card.style.borderColor = 'var(--color-primary)';
        card.append(node('span', 'text-xs model-help', `${task.id || 'ID missing'} · ${task.kind}`), node('strong', 'mt-1 break-words text-sm', task.title || 'Untitled task'));
        let drag = null;
        let moved = false;
        card.addEventListener('pointerdown', event => {
          if (event.button !== 0) return;
          moved = false;
          drag = { x: event.clientX, y: event.clientY, left: positions[index].x, top: positions[index].y };
          card.setPointerCapture(event.pointerId);
        });
        const move = (x, y) => {
          positions[index] = { x: Math.max(12, x), y: Math.max(12, y) };
          card.style.left = positions[index].x + 'px';
          card.style.top = positions[index].y + 'px';
          sizeCanvas();
          renderEdges();
        };
        card.addEventListener('pointermove', event => {
          if (!drag) return;
          const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
          if (moved) move(drag.left + dx, drag.top + dy);
        });
        card.addEventListener('pointerup', () => { drag = null; });
        card.addEventListener('pointercancel', () => { drag = null; });
        card.addEventListener('click', () => { if (!moved) selectTask(index); moved = false; });
        card.addEventListener('keydown', event => {
          const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
          if (!event.altKey || !delta) return;
          event.preventDefault();
          move(positions[index].x + delta[0], positions[index].y + delta[1]);
        });
        canvas.append(card);
      });
      sizeCanvas();
      renderEdges();
    }
    function refresh(includeEditor) {
      taskList.replaceChildren(...draft.tasks.map((task, index) => {
        const item = button(`workflow-task-select-${index}`, task.title || task.id || 'Untitled task', () => selectTask(index));
        item.setAttribute('aria-pressed', String(index === selected));
        if (index === selected) item.classList.add('btn-active');
        return item;
      }));
      if (includeEditor) renderEditor();
      else renderDependencies();
      renderCanvas();
      renderValidation();
    }
    function saveDraft() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, draft: argumentsFor(draft), positions }));
        report('Draft saved in this browser. No agents started.');
      } catch (_error) { report('The browser could not save this draft. Check storage permissions or use Export JSON for a valid draft.', true); }
    }
    function replaceDraft(value, storedPositions = []) {
      draft = argumentsFor(value);
      if (draft.max_concurrency === undefined) draft.max_concurrency = 2;
      positions = draft.tasks.map((_, index) => {
        const position = storedPositions[index];
        return isObject(position) && Number.isFinite(position.x) && Number.isFinite(position.y) && position.x >= 0 && position.y >= 0 ? { x: position.x, y: position.y } : defaultPosition(index);
      });
      selected = draft.tasks.length ? 0 : -1;
      nameInput.value = draft.name;
      concurrencyInput.value = String(draft.max_concurrency);
      refresh(true);
    }
    function reloadDraft() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) { report('No draft has been saved in this browser.'); return; }
        const saved = JSON.parse(raw);
        if (!isObject(saved) || saved.version !== 1 || !isObject(saved.draft) || !Array.isArray(saved.draft.tasks)) throw new Error('Unrecognized saved draft');
        // Incomplete drafts may be saved, but must retain the editor's field structure.
        if (typeof saved.draft.name !== 'string' || saved.draft.tasks.some(task => !isObject(task) || !['id', 'title', 'instruction', 'kind'].every(key => typeof task[key] === 'string') || !['depends_on', 'write_scopes', 'acceptance_criteria'].every(key => Array.isArray(task[key]) && task[key].every(item => typeof item === 'string')))) throw new Error('Invalid saved draft');
        replaceDraft(saved.draft, Array.isArray(saved.positions) ? saved.positions : []);
        report('Saved draft reloaded. No agents started.');
      } catch (_error) { report('The saved draft could not be read. Your current draft has been kept.', true); }
    }
    function importDraft() {
      try {
        const value = JSON.parse(importInput.value);
        const errors = validate(value);
        if (errors.length) { report('Import rejected: ' + errors.join(' '), true); return; }
        replaceDraft(value);
        report('JSON imported as a draft. Save to keep it in this browser. No agents started.');
      } catch (_error) { report('Import rejected: enter valid workflow JSON. Your current draft has been kept.', true); }
    }
    function exportText() {
      if (renderValidation().length) { report('Resolve the draft validation errors before exporting or copying.', true); return null; }
      return JSON.stringify(argumentsFor(draft), null, 2) + '\n';
    }
    function exportDraft() {
      const text = exportText();
      if (text === null) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = node('a');
      link.href = url;
      link.download = 'elpis-workflow-draft.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      report('Draft exported. No agents started.');
    }
    async function copyDraft() {
      const text = exportText();
      if (text === null) return;
      try { await navigator.clipboard.writeText(text); report('Draft JSON copied. No agents started.'); }
      catch (_error) { report('Clipboard access failed. Use Export JSON to download the draft.', true); }
    }
    refresh(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
