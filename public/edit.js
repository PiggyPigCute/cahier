(function () {
  const $ = id => document.getElementById(id);
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const loginView = $('loginView');
  const mainView = $('mainView');
  const headerActions = $('headerActions');
  const listEl = $('courseList');
  const filePicker = $('filePicker');
  const courseDialog = $('courseDialog');
  const chooserDialog = $('chooserDialog');

  let courses = [];
  let pollTimer = null;
  let pickerTarget = null;      // id du cours pour lequel le sélecteur de fichier a été ouvert
  let editing = null;           // cours en cours de modification dans la boîte de dialogue (null = nouveau)
  let pendingFile = null;       // fichier déposé en attente du choix d'un cours
  let paletteInitial = {};
  let paletteCurrent = {};
  const uploading = new Map();  // id -> avancement de l'envoi (0..1)

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child) node.append(child);
    }
    return node;
  }

  // --- messages ---

  let toastTimer = null;
  function toast(message, isError) {
    const node = $('toast');
    node.textContent = message;
    node.className = `show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.className = ''; }, isError ? 6000 : 3000);
  }

  // --- réseau ---

  function showLogin() {
    stopPolling();
    mainView.hidden = true;
    headerActions.hidden = true;
    loginView.hidden = false;
    $('password').focus();
  }

  async function api(url, options) {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // réponse sans JSON
    }
    if (res.status === 401) {
      showLogin();
      throw new Error('Session expirée, reconnectez-vous.');
    }
    if (!res.ok) throw new Error((data && data.error) || `Erreur ${res.status}`);
    return data;
  }

  function jsonRequest(method, body) {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }

  // XMLHttpRequest plutôt que fetch : seul moyen d'avoir la progression de l'envoi
  function sendForm(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // réponse sans JSON
        }
        if (xhr.status === 401) {
          showLogin();
          return reject(new Error('Session expirée, reconnectez-vous.'));
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        reject(new Error((data && data.error) || `Erreur ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("Erreur réseau pendant l'envoi."));
      xhr.send(formData);
    });
  }

  // --- liste ---

  async function refresh() {
    courses = await api('/edit/api/courses');
    render();
    const busy = courses.some(c => c.status === 'processing');
    if (busy && !pollTimer) pollTimer = setInterval(() => refresh().catch(() => {}), 1500);
    if (!busy) stopPolling();
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function pdfLink(course, variant, label) {
    return el('a', { href: `/pdf/${encodeURIComponent(course.id)}/${variant}?v=${course.version}`, target: '_blank', rel: 'noopener', text: label });
  }

  function statusBlock(course) {
    const box = el('div');
    if (uploading.has(course.id)) {
      const percent = Math.round(uploading.get(course.id) * 100);
      box.append(
        el('p', { class: 'row-busy', 'data-progress-text': course.id, text: `Envoi… ${percent} %` }),
        el('div', { class: 'bar' }, el('span', { 'data-progress-bar': course.id, style: `width:${percent}%` })),
      );
    } else if (course.status === 'processing') {
      box.append(
        el('p', { class: 'row-busy', text: course.progress || 'Conversion…' }),
        el('div', { class: 'bar indeterminate' }, el('span')),
      );
    } else if (course.status === 'error') {
      box.append(el('p', { class: 'row-error', text: course.error || 'Erreur pendant la conversion.' }));
    }
    if (course.status !== 'processing' && (course.warnings || []).length) {
      box.append(el('p', { class: 'row-warn', text: course.warnings.join(' — ') }));
    }
    return box;
  }

  function renderRow(course) {
    const busy = course.status === 'processing' || uploading.has(course.id);
    const thumb = course.hasThumb
      ? el('img', { class: 'row-thumb', src: `/thumb/${encodeURIComponent(course.id)}?v=${course.version}`, alt: '' })
      : el('div', { class: 'row-thumb' });

    const info = el('div', { class: 'row-info' },
      el('h3', { text: course.title }, el('span', { class: 'badge', text: course.year })));
    if (course.description) info.append(el('p', { class: 'row-desc', text: course.description }));
    info.append(el('p', {
      text: course.uploadedAt
        ? `Dernier envoi : ${dateFormat.format(new Date(course.uploadedAt))}${course.sourceName ? ` — ${course.sourceName}` : ''}`
        : 'Pas encore de PDF',
    }));
    info.append(statusBlock(course));
    if (course.version > 0) {
      info.append(el('p', { class: 'row-links' },
        pdfLink(course, 'normal', 'PDF'),
        pdfLink(course, 'sans-quadrillage', 'Sans quadrillage'),
        pdfLink(course, 'blanc', 'Fond blanc')));
    }

    const update = el('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'update', text: '⬆ Mettre à jour' });
    const edit = el('button', { class: 'btn btn-small', type: 'button', 'data-action': 'edit', text: 'Modifier' });
    const remove = el('button', { class: 'btn btn-small btn-danger', type: 'button', 'data-action': 'delete', text: 'Supprimer' });
    if (busy) {
      update.disabled = true;
      remove.disabled = true;
    }

    const actions = el('div', { class: 'row-actions' }, update, el('div', { class: 'secondary' }, edit, remove));
    const row = el('div', { class: 'course-row', 'data-id': course.id }, thumb, info, actions);
    return row;
  }

  function render() {
    if (!courses.length) {
      listEl.replaceChildren(el('p', { class: 'empty', text: 'Aucun cours. Ajoutez le premier avec « Nouveau cours ».' }));
      return;
    }
    listEl.replaceChildren(...courses.map(renderRow));
  }

  function courseById(id) {
    return courses.find(c => c.id === id);
  }

  listEl.addEventListener('click', e => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const id = button.closest('.course-row').dataset.id;
    const course = courseById(id);
    if (!course) return;
    const action = button.dataset.action;
    if (action === 'update') {
      pickerTarget = id;
      filePicker.value = '';
      filePicker.click();
    } else if (action === 'edit') {
      openCourseDialog(course);
    } else if (action === 'delete') {
      deleteCourse(course);
    }
  });

  async function deleteCourse(course) {
    if (!confirm(`Supprimer « ${course.title} » et ses PDF ? Cette action est définitive.`)) return;
    try {
      await api(`/edit/api/courses/${encodeURIComponent(course.id)}`, { method: 'DELETE' });
      toast('Cours supprimé.');
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // --- envoi d'un .goodnotes (mise à jour d'un cours existant : le chemin le plus utilisé) ---

  function checkFile(file) {
    if (!file || !/\.goodnotes$/i.test(file.name)) {
      toast('Le fichier doit être un .goodnotes.', true);
      return false;
    }
    return true;
  }

  function updateProgress(id, ratio) {
    uploading.set(id, ratio);
    const percent = Math.round(ratio * 100);
    const text = document.querySelector(`[data-progress-text="${CSS.escape(id)}"]`);
    const bar = document.querySelector(`[data-progress-bar="${CSS.escape(id)}"]`);
    if (text) text.textContent = ratio >= 1 ? 'Envoi terminé, conversion…' : `Envoi… ${percent} %`;
    if (bar) bar.style.width = `${percent}%`;
  }

  async function uploadToCourse(id, file) {
    if (!checkFile(file)) return;
    const form = new FormData();
    form.append('sourceName', file.name); // le nom exact (accents...) : multer déforme celui du fichier
    form.append('file', file);
    uploading.set(id, 0);
    render();
    try {
      await sendForm(`/edit/api/courses/${encodeURIComponent(id)}/upload`, form, ratio => updateProgress(id, ratio));
      toast('Fichier envoyé, conversion en cours…');
    } catch (err) {
      toast(err.message, true);
    } finally {
      uploading.delete(id);
      await refresh().catch(() => {});
    }
  }

  filePicker.addEventListener('change', () => {
    const file = filePicker.files[0];
    if (file && pickerTarget) uploadToCourse(pickerTarget, file);
    pickerTarget = null;
  });

  // le nom exporté par Goodnotes est celui du carnet : il sert à retrouver le cours
  function normalizeName(name) {
    return name.normalize('NFC').toLowerCase().trim();
  }

  function handleDroppedFile(file, dropTargetId) {
    if (!checkFile(file)) return;
    if (dropTargetId) return uploadToCourse(dropTargetId, file);
    const matches = courses.filter(c => c.sourceName && normalizeName(c.sourceName) === normalizeName(file.name));
    if (matches.length === 1) return uploadToCourse(matches[0].id, file);
    openChooser(file);
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (mainView.hidden || !e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    dragDepth += 1;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', e => {
    if (mainView.hidden) return;
    e.preventDefault(); // nécessaire pour autoriser le dépôt
    document.querySelectorAll('.course-row.drop-target').forEach(r => r.classList.remove('drop-target'));
    const row = e.target.closest && e.target.closest('.course-row');
    if (row) row.classList.add('drop-target');
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    document.querySelectorAll('.course-row.drop-target').forEach(r => r.classList.remove('drop-target'));
    if (mainView.hidden || courseDialog.open || chooserDialog.open) return;
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (!file) return;
    const row = e.target.closest && e.target.closest('.course-row');
    handleDroppedFile(file, row ? row.dataset.id : null);
  });

  // --- choix du cours pour un fichier dont le nom ne correspond à aucun cours ---

  function openChooser(file) {
    pendingFile = file;
    $('chooserFile').textContent = file.name;
    $('chooserList').replaceChildren(...courses.map(c => {
      const button = el('button', { type: 'button', class: 'btn', text: `${c.title} (${c.year})` });
      button.addEventListener('click', () => {
        chooserDialog.close();
        uploadToCourse(c.id, pendingFile);
      });
      return button;
    }));
    chooserDialog.showModal();
  }

  $('chooserCancel').addEventListener('click', () => chooserDialog.close());
  $('chooserNew').addEventListener('click', () => {
    chooserDialog.close();
    openCourseDialog(null, pendingFile);
  });

  // --- création / modification ---

  function openCourseDialog(course, file) {
    editing = course;
    $('dialogTitle').textContent = course ? 'Modifier le cours' : 'Nouveau cours';
    $('fTitle').value = course ? course.title : (file ? file.name.replace(/\.goodnotes$/i, '') : '');
    $('fDescription').value = course ? course.description : '';
    $('fYear').value = course ? course.year : 'Actuel';
    $('fileField').hidden = !!course;
    $('fFile').required = !course;
    if (file) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      $('fFile').files = transfer.files;
    } else {
      $('fFile').value = '';
    }
    $('saveBtn').disabled = false;
    $('saveBtn').textContent = 'Enregistrer';
    buildPalette(course);
    courseDialog.showModal();
    $('fTitle').focus();
  }

  function buildPalette(course) {
    const colors = course ? course.colors || [] : [];
    $('paletteBox').hidden = !colors.length || course.version === 0 || course.status === 'processing';
    paletteInitial = {};
    paletteCurrent = {};
    const rows = colors.map(color => {
      const value = (course.palette && course.palette[color.key]) || color.suggested;
      paletteInitial[color.key] = value;
      paletteCurrent[color.key] = value;

      const input = el('input', { type: 'color', value });
      const reset = el('button', { type: 'button', class: 'btn btn-small', text: 'Auto', title: 'Revenir à la couleur proposée' });
      input.addEventListener('input', () => { paletteCurrent[color.key] = input.value; });
      reset.addEventListener('click', () => {
        input.value = color.suggested;
        paletteCurrent[color.key] = color.suggested;
      });
      const swatch = el('span', { class: 'swatch', style: `background:${color.hex}` });
      const label = el('span', {},
        `${color.kind === 'surligneur' ? 'Surligneur' : 'Stylo'} ${color.hex}`,
        el('span', { class: 'count', text: `${color.count} objet${color.count > 1 ? 's' : ''}` }));
      return el('div', { class: 'palette-row' }, swatch, label, el('span', { class: 'arrow', text: '→' }), input, reset);
    });
    $('paletteRows').replaceChildren(...rows);
  }

  $('newBtn').addEventListener('click', () => openCourseDialog(null));
  $('cancelBtn').addEventListener('click', () => courseDialog.close());

  $('courseForm').addEventListener('submit', async e => {
    e.preventDefault();
    const save = $('saveBtn');
    save.disabled = true;
    const fields = {
      title: $('fTitle').value,
      description: $('fDescription').value,
      year: $('fYear').value,
    };
    try {
      if (editing) {
        await api(`/edit/api/courses/${encodeURIComponent(editing.id)}`, jsonRequest('PUT', fields));
        const changed = Object.keys(paletteCurrent).some(k => paletteCurrent[k] !== paletteInitial[k]);
        if (changed) {
          await api(`/edit/api/courses/${encodeURIComponent(editing.id)}/palette`, jsonRequest('PUT', { palette: paletteCurrent }));
          toast('Enregistré, régénération du PDF à fond blanc…');
        } else {
          toast('Enregistré.');
        }
      } else {
        const file = $('fFile').files[0];
        if (!checkFile(file)) {
          save.disabled = false;
          return;
        }
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        form.append('sourceName', file.name);
        form.append('file', file);
        await sendForm('/edit/api/courses', form, ratio => {
          save.textContent = ratio >= 1 ? 'Conversion…' : `Envoi ${Math.round(ratio * 100)} %`;
        });
        toast('Cours créé, conversion en cours…');
      }
      courseDialog.close();
      await refresh();
    } catch (err) {
      toast(err.message, true);
      save.disabled = false;
      save.textContent = 'Enregistrer';
    }
  });

  // --- connexion ---

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const res = await fetch('/edit/api/login', {
        ...jsonRequest('POST', { password: $('password').value }),
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      $('password').value = '';
      await start();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await fetch('/edit/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    showLogin();
  });

  window.addEventListener('beforeunload', e => {
    if (uploading.size) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  async function start() {
    try {
      await refresh();
      loginView.hidden = true;
      mainView.hidden = false;
      headerActions.hidden = false;
    } catch (err) {
      // en cas de 401, refresh() a déjà affiché le formulaire de connexion
      if (loginView.hidden) toast(err.message, true);
    }
  }

  start();
})();
