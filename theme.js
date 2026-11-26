// Executado antes de desenhar a página (sem scripts inline, por causa da CSP).
(function () {
  // Anti-clickjacking: a app não pode ser mostrada dentro de outro site (iframe)
  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try { window.top.location = window.self.location.href; } catch (e) { /* bloqueado */ }
  }
  // Tema escolhido (para não piscar)
  try {
    var t = localStorage.getItem('tema');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* sem armazenamento */ }
})();
