(async function () {
  const root = document.getElementById('list');
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child) node.append(child);
    }
    return node;
  }

  let courses;
  try {
    const res = await fetch('/api/courses');
    if (!res.ok) throw new Error();
    courses = await res.json();
  } catch {
    root.replaceChildren(el('p', { class: 'empty' }, 'Impossible de charger la liste des cours.'));
    return;
  }

  if (!courses.length) {
    root.replaceChildren(el('p', { class: 'empty' }, 'Aucun cours pour le moment.'));
    return;
  }

  // le serveur renvoie déjà les cours triés : on regroupe par année dans l'ordre d'apparition
  const groups = [];
  for (const course of courses) {
    let group = groups.find(g => g.year === course.year);
    if (!group) {
      group = { year: course.year, items: [] };
      groups.push(group);
    }
    group.items.push(course);
  }

  function pdfUrl(course, variant) {
    return `/pdf/${encodeURIComponent(course.id)}/${variant}?v=${course.version}`;
  }

  function card(course) {
    const thumb = el('a', { class: 'thumb', href: pdfUrl(course, 'normal'), target: '_blank', rel: 'noopener', 'aria-label': `Ouvrir ${course.title}` });
    if (course.hasThumb) {
      thumb.append(el('img', { src: `/thumb/${encodeURIComponent(course.id)}?v=${course.version}`, alt: '', loading: 'lazy' }));
    } else {
      thumb.append(el('div', { class: 'thumb-placeholder' }, course.title));
    }

    const meta = [];
    if (course.uploadedAt) meta.push(`${dateFormat.format(new Date(course.uploadedAt))}`);
    if (course.pages) meta.push(`${course.pages} page${course.pages > 1 ? 's' : ''}`);

    const link = (variant, label, primary) => el(
      'a',
      { class: primary ? 'btn btn-small btn-primary' : 'btn btn-small', href: pdfUrl(course, variant), target: '_blank', rel: 'noopener' },
      label,
    );

    const body = el('div', { class: 'card-body' }, el('h3', { class: 'card-title' }, course.title));
    if (course.description) body.append(el('p', { class: 'card-desc' }, course.description));
    body.append(
      el('p', { class: 'card-meta' }, meta.join(' · ')),
      el('div', { class: 'variants' },
        link('normal', 'Ouvrir le PDF', true),
        link('sans-quadrillage', 'Sans quadrillage'),
        link('blanc', 'Fond blanc')),
    );
    return el('article', { class: 'card' }, thumb, body);
  }

  root.replaceChildren(...groups.map(group => el(
    'section',
    { class: 'year-section' },
    el('h2', { class: 'year-title' }, group.year),
    el('div', { class: 'grid' }, ...group.items.map(card)),
  )));
})();
