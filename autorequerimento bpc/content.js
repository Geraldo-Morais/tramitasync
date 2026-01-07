// INSS Automacao BPC - content.js
// Automacao defensiva do fluxo do BPC e atalho para aba Exigencia.

(() => {
  const logPrefix = '[INSS-AUTO]';
  const log = (...args) => console.log(logPrefix, ...args);
  const delay = (ms = 500) => new Promise(resolve => setTimeout(resolve, ms));
  const SERVICE_LABEL = 'Beneficio Assistencial a Pessoa com Deficiencia';

  log('content.js carregado e aguardando comandos.');

  // Neutraliza backdrops/overlays bloqueantes de forma mais segura.
  function killAllBackdrops() {
    if (!document.body) return;

    const selectors = [
      '.modal-backdrop',
      '.dtp-block-ui',
      '.br-scrim',
      '.a.loading',
      '.a.loading.medium',
      '.a.loading.medium.dtp-loading',
      '.cdk-overlay-backdrop',
      '.overlay-backdrop',
      '.backdrop'
    ];

    selectors.forEach(sel => {
      document.body.querySelectorAll(sel).forEach(el => {
        try {
          if (el.offsetParent === null) return; // ignora se já está oculto
          el.style.pointerEvents = 'none';
          el.style.opacity = '0';
          el.style.visibility = 'hidden';
          el.style.background = 'transparent';
          el.style.backgroundColor = 'transparent';
        } catch (e) {
          // Fallback defensivo: se der erro ao inspecionar, nao explode a pagina.
        }
      });
    });

    document.body.classList.remove('modal-open');
    document.documentElement.classList.remove('modal-open');
  }

  // Observa o body para neutralizar backdrops recriados pelo site.
  function initBackdropObserver() {
    if (!document.body) {
      setTimeout(initBackdropObserver, 100);
      return;
    }
    const backdropObserver = new MutationObserver(() => {
      requestAnimationFrame(killAllBackdrops);
    });
    backdropObserver.observe(document.body, { childList: true, subtree: true });
    killAllBackdrops();
    window.inssKillBackdrops = killAllBackdrops;
    log('Observer de backdrops iniciado com seguranca.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBackdropObserver);
  } else {
    initBackdropObserver();
  }

  const state = {
    running: false,
    paused: false,
    pauseReason: '',
    resumeResolver: null,
    status: ''
  };
  // Progresso simples para retomada apos navegações internas
  const progress = {
    step: window.__inssProgress?.step || 'init'
  };

  let bannerEl;

  function normalizeText(text) {
    return (text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function showBanner(message) {
    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.setAttribute('role', 'status');
      bannerEl.style.position = 'fixed';
      bannerEl.style.top = '0';
      bannerEl.style.left = '0';
      bannerEl.style.right = '0';
      bannerEl.style.zIndex = '2147483647';
      bannerEl.style.background = '#003399';
      bannerEl.style.color = '#fff';
      bannerEl.style.padding = '8px 12px';
      bannerEl.style.fontSize = '14px';
      bannerEl.style.fontFamily = 'Arial, sans-serif';
      bannerEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
      document.body.appendChild(bannerEl);
    }
    bannerEl.textContent = message;
  }

  function hideBanner() {
    if (bannerEl && bannerEl.parentNode) {
      bannerEl.parentNode.removeChild(bannerEl);
    }
    bannerEl = null;
  }

  function setStatus(message, { persistBanner = false } = {}) {
    state.status = message;
    window.__inssAutomationStatus = message;
    log(message);
    if (persistBanner || bannerEl) {
      showBanner(message);
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findVisible(selector) {
    return Array.from(document.querySelectorAll(selector)).find(isVisible) || null;
  }

  function findCloseButton(modal) {
    if (!modal) return null;
    return Array.from(modal.querySelectorAll('button, .br-modal-close')).find(btn => {
      const text = normalizeText(btn.textContent || '');
      const aria = normalizeText(btn.getAttribute('aria-label') || '');
      return ['fechar', 'cancelar', 'ok', 'voltar'].some(keyword => text.includes(keyword) || aria.includes(keyword));
    }) || null;
  }

  function detectCaptchaElements() {
    const matches = [];
    const iframe = Array.from(document.querySelectorAll('iframe[src*="recaptcha"]')).find(isVisible);
    const widget = Array.from(document.querySelectorAll('div.g-recaptcha, [data-sitekey][class*="recaptcha"], [data-sitekey].g-recaptcha')).find(isVisible);
    const ariaCaptcha = Array.from(document.querySelectorAll('[aria-live]')).find(el => isVisible(el) && /captcha|robot|seguranca/i.test(el.textContent || ''));
    const script = document.querySelector('script[src*="recaptcha"]');
    const responseValue = (document.querySelector('.g-recaptcha-response')?.value || '').trim();

    if (iframe) matches.push('iframe[src*=recaptcha]');
    if (widget) matches.push('g-recaptcha');
    if (ariaCaptcha) matches.push('aria captcha');
    if (script) matches.push('script[src*=recaptcha]');

    return { matches, active: (iframe || widget || ariaCaptcha) && !responseValue };
  }

  function resumeAutomation(trigger = 'manual') {
    if (state.resumeResolver) {
      log(`Retomando automacao (${trigger})`);
      const resolver = state.resumeResolver;
      state.resumeResolver = null;
      state.paused = false;
      state.pauseReason = '';
      hideBanner();
      resolver();
    } else {
      log('Nenhuma pausa pendente para retomar.');
    }
  }

  window.inssAutoResume = resumeAutomation;

  function waitForResume() {
    return new Promise(resolve => {
      state.resumeResolver = resolve;
    });
  }

  async function pauseForUser(reason, message, alertUser = false) {
    state.paused = true;
    state.pauseReason = reason;
    setStatus(message, { persistBanner: true });
    if (alertUser) {
      alert(message);
    }
    await waitForResume();
  }

  async function ensureNoCaptchaBlock() {
    const captcha = detectCaptchaElements();
    if (!captcha.active) return;
    const msg = 'CAPTCHA detectado. Resolva manualmente e clique em "Retomar" no popup ou execute window.inssAutoResume().';
    log(msg, captcha.matches.join(', '));
    if (!state.paused || state.pauseReason !== 'CAPTCHA') {
      await pauseForUser('CAPTCHA', msg, true);
    } else {
      await waitForResume();
    }
  }

  function getBlockingState() {
    const loader = findVisible('.a.loading.medium.dtp-loading');
    if (loader) return { type: 'loading', description: 'Loading visivel', element: loader };

    const ariaBlock = Array.from(document.querySelectorAll('[aria-live="assertive"]')).find(el => {
      const text = (el.textContent || '').toLowerCase();
      if (text.includes('desbloqueada')) return false;
      return isVisible(el) && /bloqueio ativada|tela de bloqueio|bloqueada|bloqueio/i.test(text);
    });
    if (ariaBlock) return { type: 'aria-block', description: ariaBlock.textContent.trim() };

    const dtpBlock = Array.from(document.querySelectorAll('.dtp-block-ui')).find(el => {
      return isVisible(el) && /aguarde|bloqueio/i.test(el.textContent || '');
    });
    if (dtpBlock) return { type: 'dtp-block', description: dtpBlock.textContent.trim(), element: dtpBlock };

    const wizardPanels = document.querySelectorAll('.wizard-panel');
    if (wizardPanels.length && !document.querySelector('.wizard-panel[active="active"]')) {
      return { type: 'wizard-transition', description: 'Painel do wizard ainda nao esta ativo' };
    }

    const backdrop = findVisible('.modal-backdrop, .br-scrim.foco');
    if (backdrop) {
      // Se há um loading visível junto com o scrim, é loading, não modal
      const loadingWithScrim = findVisible('.a.loading, .dtp-loading, .loading');
      if (loadingWithScrim) {
        return { type: 'loading', description: 'Loading visivel', element: loadingWithScrim };
      }
      const modal = findVisible('.br-modal[data-show="true"], .br-modal.active, .modal[aria-modal="true"], .modal.show');
      if (modal) {
        return { type: 'modal', description: 'Modal em exibicao', modal };
      }
      // Se tem scrim mas não tem modal nem loading, ignora (pode ser transição)
    }

    return null;
  }

  async function waitForStableUI({ timeout = 30000, quiet = 200 } = {}) {
    const start = Date.now();
    let lastReason = '';
    while (true) {
      await handleErrorScreenIfAny();
      await ensureNoCaptchaBlock();
      const blocking = getBlockingState();
      if (!blocking) {
        log('UI livre, aguardando quiet', quiet);
        await delay(quiet);
        if (!getBlockingState()) return;
        continue;
      }
      log('UI bloqueada por:', blocking.type, blocking.description || '');
      lastReason = blocking.description || blocking.type;
      if (blocking.type === 'modal' && blocking.modal) {
        const closeBtn = findCloseButton(blocking.modal);
        if (closeBtn) {
          log('Fechando modal com botao disponivel:', closeBtn.textContent.trim());
          closeBtn.click();
        }
      }
      if (Date.now() - start > timeout) {
        throw new Error(`UI nao estabilizou: ${lastReason}`);
      }
      await delay(400);
    }
  }

  function waitForElement(selector, { timeout = 20000, root = document, mustBeVisible = true } = {}) {
    log(`Aguardando seletor: ${selector} (timeout ${timeout}ms)`);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const observer = new MutationObserver(check);
      observer.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
      const timer = setInterval(check, 250);

      function check() {
        const el = root.querySelector(selector);
        if (el && (!mustBeVisible || isVisible(el))) {
          cleanup();
          log(`Seletor encontrado: ${selector}`);
          return resolve(el);
        }
        if (Date.now() - start > timeout) {
          cleanup();
          log(`Timeout seletor: ${selector}`);
          return reject(new Error(`Timeout aguardando seletor: ${selector}`));
        }
      }
      function cleanup() {
        observer.disconnect();
        clearInterval(timer);
      }
      check();
    });
  }

  function setNativeValue(element, value, { blur = true } = {}) {
    if (!element) return;
    const type = (element.getAttribute('type') || '').toLowerCase();

    if (type === 'checkbox' || type === 'radio') {
      const desired = Boolean(value);
      if (element.checked !== desired) {
        element.checked = desired;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (blur) element.dispatchEvent(new Event('blur', { bubbles: true }));
      return;
    }

    const setter = Object.getOwnPropertyDescriptor(element.__proto__ || Object.getPrototypeOf(element), 'value')?.set;
    const prototypeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const valueSetter = setter || prototypeSetter;
    const lastValue = element.value;

    if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    if (value !== lastValue) {
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (blur) {
      element.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  }

  async function clickAndWait(element, label = 'acao') {
    if (!element) throw new Error(`Elemento nao encontrado para ${label}`);
    log(`Clicando em: ${label}`);
    element.click();
    await waitForStableUI();
  }

  async function clickNextIfPossible() {
    const next = findVisible('#btn-next');
    if (next) {
      await clickAndWait(next, 'Avancar');
      return true;
    }
    return false;
  }

  async function selectComboboxOption(inputSelector, targetText) {
    log(`Abrindo combobox ${inputSelector} para selecionar: ${targetText}`);
    const targetNorm = normalizeText(targetText);
    const input = await waitForElement(inputSelector);
    input.focus();
    input.click();
    const toggleBtn = input.parentElement?.querySelector('button');
    if (toggleBtn) toggleBtn.click();

    // Preenche o texto e dispara eventos para filtros baseados em teclado.
    setNativeValue(input, targetText, { blur: false });
    input.dispatchEvent(new Event('keyup', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(250);

    const list = await waitForElement('.br-list, [role="listbox"]', { timeout: 10000, mustBeVisible: false });
    // Forca exibicao se estiver colapsada.
    list.style.display = 'block';
    list.removeAttribute('hidden');
    input.setAttribute('aria-expanded', 'true');

    const items = Array.from(list.querySelectorAll('.br-item, [role="option"], label, span')).filter(el => (el.textContent || '').trim());
    let found = items.find(el => normalizeText(el.textContent).includes(targetNorm));
    if (!found) {
      log('Nao encontrei a opcao via filtro, tentando fallback global');
      found = Array.from(document.querySelectorAll('.br-item, [role="option"], label, span')).find(el => normalizeText(el.textContent).includes(targetNorm));
    }
    if (!found) {
      throw new Error(`Opcao nao encontrada no combobox: ${targetText}`);
    }
    log('Opcao encontrada, clicando...');

    const radio = found.querySelector('input[type="radio"]');
    if (radio) {
      radio.click();
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      found.click();
    }

    input.setAttribute('aria-expanded', 'false');
    list.style.display = '';
    await waitForStableUI();
  }

  async function handleModalInteressadosIfAny() {
    const modal = Array.from(document.querySelectorAll('.br-modal, .modal')).find(el => {
      const text = normalizeText(el.textContent || '');
      return isVisible(el) && text.includes('interessad');
    });
    if (!modal) return;
    const btn = findCloseButton(modal);
    if (btn) {
      log('Fechando modal de interessados');
      btn.click();
      await waitForStableUI();
    }
  }

  async function maybeHandleGrupoFamiliarManual() {
    // Primeiro, verifica se NÃO estamos na tela de gastos (que tem texto similar)
    const gastosQuestion = document.querySelector('#perguntaGastos, #lb-perguntaGastos, .comprometimentoRendaClass');
    if (gastosQuestion) {
      // Estamos na tela de gastos, não de grupo familiar
      return;
    }

    // Verifica se estamos na tela de estado civil (que também tem "grupo familiar")
    const estadoCivilSelects = document.querySelectorAll('input[id^="selectEstadoCivil"]');
    if (estadoCivilSelects.length > 0) {
      // Estamos na tela de estado civil, não é a tela manual de grupo familiar
      return;
    }

    const indicator = Array.from(document.querySelectorAll('h1,h2,h3,h4,legend')).find(el => {
      const norm = normalizeText(el.textContent || '');
      return norm.includes('grupo familiar') || norm.includes('composicao do grupo');
    });
    const addBtn = Array.from(document.querySelectorAll('button')).find(btn => {
      const norm = normalizeText(btn.textContent || '');
      return (/adicionar|incluir|novo/.test(norm) && (/integrante|membro|pessoa/.test(norm)));
    });
    if (indicator || addBtn) {
      const msg = 'Tela de grupo familiar detectada. Preencha manualmente e clique em "Retomar" para continuar.';
      log(msg);
      await pauseForUser('GRUPO_FAMILIAR', msg, true);
      await waitForStableUI();
    }
  }

  async function goToNovoRequerimento() {
    setStatus('Aguardando botao "Novo Requerimento"');
    await waitForStableUI();
    const selectors = [
      'button#btn-novo-requerimento',
      'button.dtp-btn.dtp-primary',
      'button[title="Novo Requerimento"]',
      '.dtp-wizard-2-botoes button',
      'button.br-button.circle',
      'button.br-button[aria-label*="Novo Requerimento"]',
      'button.br-button[title*="Novo Requerimento"]'
    ];
    const btnNovo = await waitForFirstVisible(selectors);
    log('Botao "Novo Requerimento" encontrado, clicando.', btnNovo?.outerHTML || '');
    await clickAndWait(btnNovo, 'Novo Requerimento');
  }

  async function waitForFirstVisible(selectors, timeout = 20000) {
    log('Aguardando primeiro seletor visivel entre:', selectors.join(' | '));
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        for (const sel of selectors) {
          const candidate = findVisible(sel);
          if (candidate) return resolve(candidate);
        }
        if (Date.now() - start > timeout) {
          return reject(new Error(`Timeout aguardando qualquer seletor: ${selectors.join(' | ')}`));
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  async function handleErrorScreenIfAny() {
    const errorLabel = Array.from(document.querySelectorAll('label,b,strong,p,div,h1,h2,h3')).find(el => {
      return normalizeText(el.textContent).includes('nao foi possivel processar essa informacao neste momento');
    });
    const voltarBtn = Array.from(document.querySelectorAll('button')).find(btn => normalizeText(btn.textContent).includes('voltar'));
    if (errorLabel && voltarBtn) {
      log('Tela de erro detectada, clicando em Voltar');
      voltarBtn.click();
      await delay(500);
    }
  }

  async function escolherServico() {
    setStatus('Selecionando servico BPC');
    await waitForStableUI();
    await selectServicoBPC();
    progress.step = 'servico-selecionado';
    window.__inssProgress = { step: progress.step };
    // Avanca para a próxima etapa sem depender de continuidade linear
    await preencherCPF(window.__inssPendingConfig?.cpf || '');
  }

  // Contador para evitar loop infinito
  let servicoTentativas = 0;
  const MAX_SERVICO_TENTATIVAS = 3;

  async function selectServicoBPC() {
    log('Tentando selecionar servico via combobox (modo direto).');
    servicoTentativas++;

    if (servicoTentativas > MAX_SERVICO_TENTATIVAS) {
      throw new Error(`Falha ao selecionar servico apos ${MAX_SERVICO_TENTATIVAS} tentativas. Verifique manualmente.`);
    }

    const input = await waitForElement('#idSelecionarServico');

    // Primeiro, abrir o dropdown clicando no input ou no botão toggle
    input.focus();
    input.click();
    await delay(150);

    const toggleBtn = input.parentElement?.querySelector('button[data-trigger], button[aria-label*="lista"]');
    if (toggleBtn) {
      toggleBtn.click();
      await delay(250);
    }

    // Aguarda a lista ficar visível
    const list = await waitForElement('#idSelecionarServico-itens, .br-list[role="listbox"]', { timeout: 10000, mustBeVisible: false });

    // Força a lista a ficar visível
    list.style.cssText += '; display:block !important; visibility:visible !important; opacity:1 !important; max-height:60vh; overflow:auto;';
    list.removeAttribute('hidden');
    input.setAttribute('aria-expanded', 'true');
    await delay(300);

    // Busca o item do BPC pelo texto (mais robusto que por ID)
    let chosenItem = null;
    const items = Array.from(list.querySelectorAll('.br-item[role="option"], .br-item'));

    for (const item of items) {
      const itemText = normalizeText(item.textContent || '');
      if (itemText.includes('beneficio assistencial') && itemText.includes('pessoa com deficiencia')) {
        chosenItem = item;
        break;
      }
    }

    if (!chosenItem) {
      throw new Error('Item do servico BPC nao encontrado na lista.');
    }

    log('Item BPC encontrado:', chosenItem.textContent?.substring(0, 50));

    // ABORDAGEM: Simular navegação por teclado como um usuário faria
    // 1. Focar no item
    // 2. Disparar evento de clique via teclado (Enter ou Espaço)

    // Prepara um observer para detectar quando o React atualizar o input
    const inputValueChanged = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 3000);

      const observer = new MutationObserver(() => {
        if (input.value && normalizeText(input.value).includes('beneficio')) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve(true);
        }
      });

      observer.observe(input, { attributes: true, attributeFilter: ['value'] });

      // Também verifica periodicamente o value (React pode não triggerar mutation)
      const interval = setInterval(() => {
        if (input.value && normalizeText(input.value).includes('beneficio')) {
          observer.disconnect();
          clearInterval(interval);
          clearTimeout(timeout);
          resolve(true);
        }
      }, 100);

      setTimeout(() => clearInterval(interval), 3000);
    });

    // Foca no item (simula Tab ou navegação)
    chosenItem.focus();
    chosenItem.scrollIntoView({ block: 'center' });
    await delay(100);

    // Clica no item (isso deve acionar o handler do React)
    chosenItem.click();
    log('Clicou no br-item');
    await delay(150);

    // Se ainda não selecionou, tenta clicar no label diretamente
    if (!input.value || !normalizeText(input.value).includes('beneficio')) {
      const label = chosenItem.querySelector('label');
      if (label) {
        label.click();
        log('Clicou na label dentro do item');
        await delay(150);
      }
    }

    // Se ainda não selecionou, tenta simular Enter
    if (!input.value || !normalizeText(input.value).includes('beneficio')) {
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      chosenItem.dispatchEvent(enterEvent);
      log('Disparou Enter no item');
      await delay(150);
    }

    // Se ainda não selecionou, usa o método do form/submit
    if (!input.value || !normalizeText(input.value).includes('beneficio')) {
      const radio = chosenItem.querySelector('input[type="radio"]');
      if (radio) {
        // Simula um clique real usando dispatchEvent
        const clickEvent = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: radio.getBoundingClientRect().x + 5,
          clientY: radio.getBoundingClientRect().y + 5
        });
        radio.dispatchEvent(clickEvent);
        log('Disparou MouseEvent no radio');
        await delay(200);
      }
    }

    // Aguarda o React atualizar ou timeout
    const reactUpdated = await inputValueChanged;
    log('React atualizou o input:', reactUpdated, '- Valor:', input.value);

    // Última tentativa: força o valor se nada funcionou
    if (!input.value || !normalizeText(input.value).includes('beneficio')) {
      log('FORCANDO VALOR - nenhuma estrategia funcionou');
      const servicoTexto = 'Benefício Assistencial à Pessoa com Deficiência';

      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, servicoTexto);
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await delay(200);
    }

    // Fecha o dropdown
    input.setAttribute('aria-expanded', 'false');

    // Tenta fechar clicando no toggle novamente
    if (toggleBtn) toggleBtn.click();
    document.body.click();
    await delay(200);

    log('Valor final no input:', input.value);

    // Aguarda UI estabilizar
    await waitForStableUI();

    // Verifica se funcionou
    const inputValFinal = normalizeText(input.value || '');
    if (inputValFinal.includes('beneficio assistencial')) {
      log('Servico BPC selecionado com sucesso.');
      servicoTentativas = 0;
    } else {
      log('AVISO: Selecao pode ter falhado. Valor:', input.value);
    }

    await delay(500);
    const btnNext = await waitForElement('#btn-next');
    await clickAndWait(btnNext, 'Avancar apos servico');
  }

  async function preencherCPF(cpf) {
    setStatus('Preenchendo CPF');
    await waitForStableUI();

    // Verifica se ainda estamos na tela de serviço
    // Usa um indicador diferente: a presença do input de CPF
    const cpfInputExists = document.querySelector('[id="idRequerente.cpf"], input[placeholder*="CPF do requerente"]');
    const servInput = document.querySelector('#idSelecionarServico');

    // Se o input de CPF existe, estamos na tela certa
    if (cpfInputExists) {
      log('Input de CPF encontrado, estamos na tela correta.');
    } else if (servInput && progress.step !== 'servico-selecionado') {
      // Ainda na tela de serviço e não tentamos selecionar ainda
      log('Ainda na tela de servico, tentando selecionar...');
      if (servicoTentativas < MAX_SERVICO_TENTATIVAS) {
        await escolherServico();
        return; // escolherServico já chama preencherCPF
      } else {
        throw new Error('Loop detectado: servico nao selecionado apos multiplas tentativas.');
      }
    }

    const cpfInput = await findCPFInput();
    log('Input CPF encontrado:', cpfInput?.outerHTML?.substring(0, 100) || '');
    setNativeValue(cpfInput, cpf);
    await delay(300);

    // Encontra o botão Buscar (pode ter diferentes estruturas)
    const btnBuscar = cpfInput.parentElement?.querySelector('button, .br-button')
      || document.querySelector('[id*="Requerente"] button')
      || Array.from(document.querySelectorAll('button.br-button')).find(b =>
        normalizeText(b.textContent || '').includes('buscar')
      );

    if (btnBuscar) {
      log('Clicando em Buscar CPF');
      btnBuscar.click();

      // Aguarda o spinner desaparecer (pode demorar alguns segundos)
      log('Aguardando carregamento dos dados do requerente...');
      await waitForStableUI({ timeout: 15000 });

      // Espera adicional para garantir que os dados carregaram
      await delay(1000);

      // Verifica se o nome do requerente apareceu (indica sucesso)
      const nomeRequerente = document.querySelector('[id*="nome"], input[id*="nome"], .dados-requerente');
      if (nomeRequerente) {
        log('Dados do requerente carregados');
      }
    } else {
      log('Botao de busca de CPF nao encontrado, seguindo...');
    }

    // Aguarda UI estabilizar novamente
    await waitForStableUI();
    await delay(500);

    // Procura o botão Avançar com múltiplos seletores
    const btnNextSelectors = [
      '#btn-next',
      'button.wizard-btn-next',
      'button.br-button.primary.wizard-btn-next',
      'button[id="btn-next"]'
    ];

    let btnNext = null;
    for (const sel of btnNextSelectors) {
      btnNext = document.querySelector(sel);
      if (btnNext) {
        log('Botao Avancar encontrado com seletor:', sel);
        break;
      }
    }

    if (!btnNext) {
      // Tenta aguardar mais um pouco
      log('Aguardando botao Avancar aparecer...');
      btnNext = await waitForElement('#btn-next', { timeout: 10000 });
    }

    // Aguarda o botão estar habilitado (não disabled)
    let tentativas = 0;
    while (btnNext.disabled && tentativas < 20) {
      log('Botao Avancar desabilitado, aguardando...');
      await delay(500);
      tentativas++;
    }

    if (btnNext.disabled) {
      log('AVISO: Botao continua desabilitado, tentando clicar mesmo assim');
    }

    await clickAndWait(btnNext, 'Avancar apos CPF');
  }

  async function findCPFInput() {
    const selectors = [
      '[id="idRequerente.cpf"]',
      'input[id^="idRequerente\\.cpf"]',
      'input[id*="Requerente"][id*="cpf"]',
      'input[name*="cpf"]',
      'input[placeholder*="CPF"]',
      'input[aria-label*="CPF"]',
      'input[data-testid*="cpf"]',
      'input[type="text"][maxlength="14"]'
    ];
    log('Procurando input CPF entre:', selectors.join(' | '));
    for (const sel of selectors) {
      try {
        const el = await waitForElement(sel, { timeout: 5000, mustBeVisible: false });
        if (el) return el;
      } catch (e) {
        // tenta o proximo seletor
      }
    }
    throw new Error('Input de CPF nao encontrado nos seletores conhecidos.');
  }

  async function autorizarCadunico() {
    setStatus('Autorizando CadUnico');
    await waitForStableUI();

    // A checkbox do CadÚnico tem uma estrutura br-checkbox
    // Pode clicar na label ou no container para marcar
    const selectors = [
      '#campo-autorizacaoCadunico',
      'input[name*="autorizacaoCadunico"]',
      'input[id*="autorizacaoCadunico"]',
      '.br-checkbox input[type="checkbox"]'
    ];

    let checkbox = null;
    for (const sel of selectors) {
      checkbox = document.querySelector(sel);
      if (checkbox) {
        log('Checkbox CadUnico encontrada:', sel);
        break;
      }
    }

    if (!checkbox) {
      // Tenta encontrar pelo texto da label
      const labels = Array.from(document.querySelectorAll('label'));
      for (const label of labels) {
        if (normalizeText(label.textContent || '').includes('autorizo o uso dos dados do cadunico')) {
          const brCheckbox = label.closest('.br-checkbox');
          if (brCheckbox) {
            checkbox = brCheckbox.querySelector('input[type="checkbox"]');
            log('Checkbox CadUnico encontrada via label');
            break;
          }
        }
      }
    }

    if (!checkbox) {
      throw new Error('Checkbox de autorizacao CadUnico nao encontrada');
    }

    // Encontra elementos para clicar
    const brCheckbox = checkbox.closest('.br-checkbox');

    // Tenta encontrar a label de várias formas
    let targetLabel = null;

    // 1. Busca label pelo texto (mais confiável)
    const allLabels = document.querySelectorAll('label');
    for (const lbl of allLabels) {
      const txt = normalizeText(lbl.textContent || '');
      if (txt.includes('autorizo o uso dos dados do cadunico')) {
        targetLabel = lbl;
        log('Label encontrada por texto');
        break;
      }
    }

    // 2. Busca por ID ou for
    if (!targetLabel) {
      targetLabel = document.getElementById('autorizacaoCadunico')
        || document.querySelector('label[for="campo-autorizacaoCadunico"]')
        || document.querySelector('label[for*="autorizacao"]');
    }

    log('Estado inicial da checkbox:', checkbox.checked);
    log('Label encontrada:', targetLabel ? 'sim' : 'nao');
    log('brCheckbox encontrado:', brCheckbox ? 'sim' : 'nao');

    // Prepara um observer para detectar quando o React atualizar a checkbox
    const checkboxChanged = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);

      // Observer para mudanças no atributo checked
      const observer = new MutationObserver(() => {
        if (checkbox.checked) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve(true);
        }
      });

      observer.observe(checkbox, { attributes: true, attributeFilter: ['checked'] });

      // Também verifica periodicamente (React pode não triggerar mutation)
      const interval = setInterval(() => {
        if (checkbox.checked) {
          observer.disconnect();
          clearInterval(interval);
          clearTimeout(timeout);
          resolve(true);
        }
      }, 100);

      setTimeout(() => clearInterval(interval), 5000);
    });

    // Se já está marcada, desmarca primeiro
    if (checkbox.checked) {
      log('Checkbox ja marcada, desmarcando primeiro...');
      if (brCheckbox) brCheckbox.click();
      else if (targetLabel) targetLabel.click();
      else checkbox.click();
      await delay(300);
    }

    // ESTRATÉGIA 1: Foca no container e dispara Space (como usuário faria)
    log('Estrategia 1: Focus + Space no container...');
    if (brCheckbox) {
      brCheckbox.focus();
      brCheckbox.scrollIntoView({ block: 'center' });
      await delay(100);

      const spaceEvent = new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        keyCode: 32,
        which: 32,
        bubbles: true,
        cancelable: true
      });
      brCheckbox.dispatchEvent(spaceEvent);

      // Também dispara keyup
      const spaceUpEvent = new KeyboardEvent('keyup', {
        key: ' ',
        code: 'Space',
        keyCode: 32,
        which: 32,
        bubbles: true,
        cancelable: true
      });
      brCheckbox.dispatchEvent(spaceUpEvent);

      log('Disparou Space no br-checkbox');
      await delay(300);
    }

    // ESTRATÉGIA 2: Clica na label
    if (!checkbox.checked && targetLabel) {
      log('Estrategia 2: Click na label...');
      targetLabel.click();
      await delay(300);
    }

    // ESTRATÉGIA 3: Clica no container
    if (!checkbox.checked && brCheckbox) {
      log('Estrategia 3: Click no container...');
      brCheckbox.click();
      await delay(300);
    }

    // ESTRATÉGIA 4: Focus no checkbox + Enter
    if (!checkbox.checked) {
      log('Estrategia 4: Focus + Enter no checkbox...');
      checkbox.focus();
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      checkbox.dispatchEvent(enterEvent);
      await delay(300);
    }

    // ESTRATÉGIA 5: MouseEvent no checkbox
    if (!checkbox.checked) {
      log('Estrategia 5: MouseEvent no checkbox...');
      const rect = checkbox.getBoundingClientRect();
      const clickEvent = new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      });
      checkbox.dispatchEvent(clickEvent);
      await delay(300);
    }

    // Aguarda o observer ou timeout
    const reactUpdated = await checkboxChanged;
    log('React atualizou checkbox:', reactUpdated, '- Estado:', checkbox.checked);

    // Última tentativa: força o estado (mas provavelmente não vai funcionar com React)
    if (!checkbox.checked) {
      log('AVISO: Todas estrategias falharam, forcando estado...');
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      await delay(300);
    }

    log('Checkbox CadUnico marcada:', checkbox.checked);

    // Aguarda um tempo para o sistema processar
    await waitForStableUI();
    await delay(2000);

    // Procura o botão Avançar com múltiplos seletores
    const btnNextSelectors = [
      '#btn-next',
      'button.wizard-btn-next',
      'button.br-button.primary.wizard-btn-next',
      'button[id="btn-next"]'
    ];

    let btnNext = null;
    for (const sel of btnNextSelectors) {
      btnNext = document.querySelector(sel);
      if (btnNext && isVisible(btnNext)) {
        log('Botao Avancar encontrado com seletor:', sel);
        break;
      }
    }

    if (!btnNext) {
      log('Aguardando botao Avancar aparecer...');
      btnNext = await waitForElement('#btn-next', { timeout: 10000 });
    }

    // Aguarda o botão estar habilitado
    let tentativas = 0;
    while (btnNext.disabled && tentativas < 10) {
      log('Botao Avancar desabilitado, aguardando...');
      await delay(500);
      tentativas++;
    }

    await clickAndWait(btnNext, 'Avancar autorizacao');

    // Verifica se há erro de validação após clicar
    await delay(500);
    const erroMsg = document.querySelector('.br-message.danger, .alert-danger, .error-message');
    if (erroMsg && isVisible(erroMsg) && normalizeText(erroMsg.textContent || '').includes('cadunico')) {
      log('ERRO: Autorizacao CadUnico nao foi aceita, tentando novamente...');
      // Tenta clicar novamente na checkbox
      if (brCheckbox) brCheckbox.click();
      await delay(500);
      if (brCheckbox) brCheckbox.click();
      await delay(1000);
      await clickAndWait(btnNext, 'Avancar autorizacao (retry)');
    }
  }

  async function preencherEstadoCivil() {
    setStatus('Preenchendo estado civil (Solteiro para todos)');
    await waitForStableUI();
    await delay(1000); // Aguarda a tabela carregar

    // Tenta múltiplos seletores para encontrar os campos de estado civil
    // IMPORTANTE: Excluir o idSelecionarServico que também é um combobox
    const estadoCivilSelectors = [
      'input[id^="selectEstadoCivil"]',
      'input[id*="estadoCivil"]:not([id*="Servico"])',
      'input[id*="EstadoCivil"]:not([id*="Servico"])',
      // Seletores mais específicos para a tabela de grupo familiar
      '.wizard-panel-content table .br-select input[role="combobox"]',
      '.wizard-panel-content .grupo-familiar input[role="combobox"]'
    ];

    let estadoCivilInputs = [];
    for (const sel of estadoCivilSelectors) {
      const found = document.querySelectorAll(sel);
      // Filtra para excluir o seletor de serviço
      const filtered = Array.from(found).filter(el =>
        !el.id.includes('SelecionarServico') &&
        !el.id.includes('idSelecionarServico') &&
        !el.closest('#idSelecionarServico')
      );
      if (filtered.length > 0) {
        estadoCivilInputs = filtered;
        log('Campos de estado civil encontrados com seletor:', sel, '- Total:', filtered.length);
        break;
      }
    }

    // Se não encontrou por seletores, tenta encontrar pela estrutura da tabela
    if (estadoCivilInputs.length === 0) {
      log('Tentando encontrar selects na tabela de grupo familiar...');
      const rows = document.querySelectorAll('table tbody tr, .grupo-familiar tr');
      log('Linhas encontradas na tabela:', rows.length);

      for (const row of rows) {
        const selects = row.querySelectorAll('.br-select, select');
        for (const select of selects) {
          const input = select.querySelector('input[role="combobox"]');
          if (input) {
            estadoCivilInputs = [...estadoCivilInputs, input];
          }
        }
      }
      log('Total de inputs encontrados na tabela:', estadoCivilInputs.length);
    }

    // Se ainda não encontrou, pode ser que não tenha campo de estado civil nesta tela
    if (estadoCivilInputs.length === 0) {
      log('Nenhum campo de estado civil encontrado - pode ser que a tela nao tenha este campo');
      // Apenas clica em Avançar
    } else {
      // Processa cada campo de estado civil
      for (const input of estadoCivilInputs) {
        try {
          log('Processando campo de estado civil:', input.id || input.outerHTML.substring(0, 50));

          // Abre o dropdown clicando no input
          input.focus();
          input.click();
          await delay(200);

          const toggleBtn = input.parentElement?.querySelector('button');
          if (toggleBtn) {
            toggleBtn.click();
            await delay(200);
          }

          // Encontra a lista correspondente
          const listId = input.getAttribute('aria-controls');
          let list = listId ? document.getElementById(listId) : null;
          if (!list) {
            list = input.closest('.br-select')?.querySelector('.br-list[role="listbox"]');
          }
          if (!list) {
            list = document.querySelector('.br-list[role="listbox"]:not([hidden])');
          }

          if (!list) {
            log('Lista de estado civil nao encontrada para', input.id);
            continue;
          }

          // Força a lista a aparecer
          list.style.cssText += '; display:block !important; visibility:visible !important;';
          await delay(100);

          // Busca o item "Solteiro" na lista
          const items = Array.from(list.querySelectorAll('.br-item, [role="option"]'));
          let solteiroItem = null;

          for (const item of items) {
            const itemText = normalizeText(item.textContent || '');
            if (itemText.includes('solteiro')) {
              solteiroItem = item;
              break;
            }
          }

          if (solteiroItem) {
            // Usa a mesma técnica que funcionou para o serviço BPC
            // 1. Foca no item
            solteiroItem.focus();
            solteiroItem.scrollIntoView({ block: 'center' });
            await delay(100);

            // 2. Clica no item
            solteiroItem.click();
            log('Clicou no item Solteiro');
            await delay(150);

            // 3. Se ainda não selecionou, clica na label
            if (!input.value || !normalizeText(input.value).includes('solteiro')) {
              const label = solteiroItem.querySelector('label');
              if (label) {
                label.click();
                log('Clicou na label Solteiro');
                await delay(150);
              }
            }

            // 4. Se ainda não selecionou, dispara Enter
            if (!input.value || !normalizeText(input.value).includes('solteiro')) {
              const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
              });
              solteiroItem.dispatchEvent(enterEvent);
              log('Disparou Enter no item Solteiro');
              await delay(150);
            }

            log('Estado civil Solteiro selecionado, valor:', input.value);
          } else {
            log('Opcao Solteiro nao encontrada na lista');
          }

          // Fecha a lista
          list.style.display = 'none';
          await delay(150);
        } catch (e) {
          log('Erro ao preencher estado civil:', e.message);
        }
      }
    }

    // Responde "Não" para a pergunta sobre incluir/excluir membros do grupo familiar
    // Busca tags que contenham exatamente "Não"
    const allTags = document.querySelectorAll('.br-tag');
    let naoClicado = false;
    for (const tag of allTags) {
      const tagText = normalizeText(tag.textContent || '');
      // Verifica se é exatamente "Não" ou "nao", não "Sim"
      if ((tagText === 'nao' || tagText.match(/^nao$/i)) && !naoClicado) {
        const input = tag.querySelector('input');
        if (input && !input.checked) {
          tag.click();
          log('Clicou em Nao para pergunta do grupo familiar');
          naoClicado = true;
          await delay(100);
          break;
        } else if (input && input.checked) {
          log('Nao ja estava selecionado');
          naoClicado = true;
          break;
        }
      }
    }

    await waitForStableUI();
    await delay(500);

    // NÃO avança automaticamente - mostra banner e aguarda usuário clicar Avançar
    setStatus('Estado civil preenchido - REVISE e clique Avançar manualmente', { persistBanner: true });
    log('Estado civil preenchido. Aguardando usuario clicar Avancar...');

    // Aguarda até que a tela mude (detecta tela de gastos ou outra)
    // Isso acontece quando o usuário clica em Avançar
    const startTime = Date.now();
    const maxWait = 300000; // 5 minutos para revisar

    while (Date.now() - startTime < maxWait) {
      await waitForStableUI({ timeout: 2000 });

      // Verifica se mudou para a tela de gastos - múltiplos seletores
      const gastosQuestion = document.querySelector('#perguntaGastos, #perguntaGastos-Sim, #perguntaGastos-Nao');
      const gastosLabel = document.querySelector('#lb-perguntaGastos');
      const comprometimentoDiv = document.querySelector('.comprometimentoRendaClass');
      const gastosSimTag = document.querySelector('.br-tag.sim.interaction-select');

      // Verifica texto da pergunta de gastos
      const wizardContent = document.querySelector('.wizard-panel-content');
      const hasGastosText = wizardContent && normalizeText(wizardContent.textContent || '').includes('gastos devido');

      if (gastosQuestion || gastosLabel || comprometimentoDiv || (gastosSimTag && hasGastosText)) {
        log('Tela de gastos detectada. Continuando automacao...');
        hideBanner();
        return; // Sai da função para continuar o fluxo
      }

      // Verifica se ainda está na tela de estado civil
      const estadoCivilInput = document.querySelector('input[id^="selectEstadoCivil"]');
      if (!estadoCivilInput) {
        log('Input de estado civil nao encontrado. Tela mudou. Continuando...');
        hideBanner();
        return; // Sai da função para continuar o fluxo
      }

      await delay(500);
    }

    log('Timeout aguardando usuario avancar estado civil');
    hideBanner();
  }

  async function responderGastos() {
    setStatus('Respondendo pergunta de gastos (Sim)');
    await waitForStableUI();

    // PARTE 1: Clica no "Sim" da pergunta de gastos usando Focus + Space + verificação
    log('Procurando botao Sim para gastos...');

    // Encontra o span.br-tag.sim dentro da pergunta de gastos
    const gastosSimSpan = document.querySelector('#wizardNovoRequerimento .br-tag.sim.interaction-select') ||
      document.querySelector('.perguntaComp .br-tag.sim.interaction-select') ||
      document.querySelector('.br-tag.sim.interaction-select');
    const gastosSimInput = document.querySelector('#perguntaGastos-Sim');

    if (gastosSimSpan && (!gastosSimInput || !gastosSimInput.checked)) {
      log('Encontrado span Sim para gastos');

      // Usa MutationObserver para detectar quando React atualiza
      const simMarked = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 3000);

        const observer = new MutationObserver(() => {
          const input = document.querySelector('#perguntaGastos-Sim');
          if (input && input.checked) {
            clearTimeout(timeout);
            observer.disconnect();
            log('React atualizou Sim para gastos: marcado');
            resolve(true);
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['checked', 'class', 'aria-checked']
        });

        // Estratégia 1: Focus + Space
        gastosSimSpan.focus();
        gastosSimSpan.scrollIntoView({ block: 'center' });

        const spaceDown = new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          keyCode: 32,
          which: 32,
          bubbles: true,
          cancelable: true
        });
        gastosSimSpan.dispatchEvent(spaceDown);

        const spaceUp = new KeyboardEvent('keyup', {
          key: ' ',
          code: 'Space',
          keyCode: 32,
          which: 32,
          bubbles: true,
          cancelable: true
        });
        gastosSimSpan.dispatchEvent(spaceUp);

        // Também tenta click
        gastosSimSpan.click();

        log('Disparou Space e click no Sim para gastos');
      });

      if (!simMarked) {
        // Fallback: clica diretamente no input
        if (gastosSimInput && !gastosSimInput.checked) {
          gastosSimInput.click();
          log('Fallback: clicou diretamente no input Sim');
        }
      }

      await delay(1000);
    }

    // Aguarda a tabela de switches aparecer
    log('Aguardando tabela de switches aparecer...');
    await waitForStableUI();

    // Aguarda até a tabela com Medicamentos aparecer (max 5 segundos)
    const tableAppeared = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        log('Timeout aguardando tabela de Medicamentos');
        resolve(false);
      }, 5000);

      const checkTable = () => {
        const allRows = document.querySelectorAll('tbody tr');
        for (const row of allRows) {
          const text = normalizeText(row.textContent || '');
          if (text.includes('medicamentos')) {
            clearTimeout(timeout);
            log('Tabela de Medicamentos encontrada');
            resolve(true);
            return;
          }
        }
        setTimeout(checkTable, 200);
      };
      checkTable();
    });

    // PARTE 2: Marca os switches - busca diretamente na tabela de gastos
    setStatus('Marcando switches (Medicamentos e Consultas)');

    // Busca todas as linhas de tabela que contêm switches
    const allRows = document.querySelectorAll('tbody tr');
    log('Total de linhas encontradas:', allRows.length);

    // Helper para marcar um switch
    async function markSwitch(sw) {
      const input = sw.querySelector('input[type="checkbox"]');
      if (input && !input.checked) {
        sw.focus();
        sw.scrollIntoView({ block: 'center' });

        const spaceDown = new KeyboardEvent('keydown', {
          key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true
        });
        sw.dispatchEvent(spaceDown);
        sw.click();

        await delay(300);

        // Se não marcou, tenta no input
        if (!input.checked) {
          input.click();
          await delay(200);
        }

        return input.checked;
      }
      return input?.checked || false;
    }

    // Filtra para encontrar Medicamentos e Consultas
    for (const row of allRows) {
      const firstCell = row.querySelector('td:first-child');
      const cellText = normalizeText(firstCell?.textContent || '');

      // Verifica se é Medicamentos ou Consultas
      if (cellText.includes('medicamentos') || cellText.includes('consultas')) {
        log('Processando linha:', firstCell?.textContent?.trim());

        // PASSO 1: Encontra e marca o PRIMEIRO switch (coluna "Gastos com renda comprometida?")
        let switches = row.querySelectorAll('.br-switch');
        log('Switches encontrados inicialmente:', switches.length);

        if (switches.length >= 1) {
          const marked1 = await markSwitch(switches[0]);
          log(`Switch 1 (Gastos comprometidos): ${marked1 ? 'MARCADO' : 'falhou'}`);

          // PASSO 2: Aguarda que React renderize os switches adicionais
          await delay(1000);
          await waitForStableUI();

          // PASSO 3: Re-busca switches (agora devem ter aparecido mais)
          switches = row.querySelectorAll('.br-switch');
          log('Switches encontrados após marcar primeiro:', switches.length);

          // PASSO 4: Marca o SEGUNDO switch (coluna "Trata-se de uso contínuo?")
          if (switches.length >= 2) {
            const marked2 = await markSwitch(switches[1]);
            log(`Switch 2 (Uso contínuo): ${marked2 ? 'MARCADO' : 'falhou'}`);
          }
        }
      }
    }

    await waitForStableUI();
    await delay(500);

    // Clica no botão Avançar
    const btnNext = document.querySelector('#btn-next');
    if (btnNext) {
      log('Clicando em Avancar');
      btnNext.click();
    }

    await waitForStableUI();
    log('Gastos e switches concluídos');
  }

  // Função vazia mantida para compatibilidade - a lógica foi movida para responderGastos
  async function responderSwitches() {
    // Switches agora são marcados dentro de responderGastos
    log('responderSwitches: logica movida para responderGastos');
  }

  async function responderSUAS() {
    setStatus('Respondendo pergunta SUAS (Não)');
    await waitForStableUI();

    log('Procurando botao Nao para SUAS...');

    // Seletores específicos para SUAS
    const suasNaoInput = document.querySelector('#perguntaSUAS-Nao');
    const suasNaoSpan = document.querySelector('.divSUAS .br-tag.nao.interaction-select') ||
      document.querySelector('#perguntaSUAS-Nao')?.closest('.br-tag');

    if (suasNaoSpan && (!suasNaoInput || !suasNaoInput.checked)) {
      log('Encontrado span Não para SUAS');

      // Usa MutationObserver para detectar quando React atualiza
      const naoMarked = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 3000);

        const observer = new MutationObserver(() => {
          const input = document.querySelector('#perguntaSUAS-Nao');
          if (input && input.checked) {
            clearTimeout(timeout);
            observer.disconnect();
            log('React atualizou Não para SUAS: marcado');
            resolve(true);
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['checked', 'class', 'aria-checked']
        });

        // Focus + Space
        suasNaoSpan.focus();
        suasNaoSpan.scrollIntoView({ block: 'center' });

        const spaceDown = new KeyboardEvent('keydown', {
          key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true
        });
        suasNaoSpan.dispatchEvent(spaceDown);

        const spaceUp = new KeyboardEvent('keyup', {
          key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true
        });
        suasNaoSpan.dispatchEvent(spaceUp);

        // Também tenta click
        suasNaoSpan.click();

        log('Disparou Space e click no Não para SUAS');
      });

      if (!naoMarked) {
        // Fallback: clica diretamente no input
        if (suasNaoInput && !suasNaoInput.checked) {
          suasNaoInput.click();
          log('Fallback: clicou diretamente no input Não SUAS');
        }
      }

      await delay(500);
    }

    // Clica no botão Avançar
    const btnNext = document.querySelector('#btn-next');
    if (btnNext) {
      log('Clicando em Avancar SUAS');
      btnNext.click();
    }

    // Aguarda carregamento mas fecha modals que aparecerem
    await delay(1000);

    // Fecha qualquer modal que aparecer (incluindo modal de contato)
    for (let i = 0; i < 5; i++) {
      const modal = document.querySelector('.br-modal, .modal');
      if (modal && isVisible(modal)) {
        const closeBtn = modal.querySelector('button.close, .btn-close, button[aria-label*="Fechar"], button[aria-label*="Close"]') ||
          Array.from(modal.querySelectorAll('button')).find(b => /fechar|close|ok|confirmar/i.test(b.textContent || ''));
        if (closeBtn) {
          closeBtn.click();
          log('Modal fechado após SUAS');
          await delay(500);
        }
      }
      await delay(200);
    }

    // Usa waitForStableUI com timeout menor e ignora modals
    try {
      await waitForStableUI({ timeout: 5000 });
    } catch (e) {
      log('Timeout esperando UI após SUAS, continuando...');
    }

    log('SUAS concluído');
  }

  async function preencherContato(celular) {
    setStatus('Preenchendo contato');
    await waitForStableUI();

    log('Iniciando preenchimento de contato no modal...');

    // PASSO 1: Selecionar "Celular" no dropdown de tipo de contato
    log('Abrindo dropdown de tipo de contato...');
    const selectTipoContato = document.querySelector('#selectTipoContato');

    if (selectTipoContato) {
      // Clica para abrir o dropdown
      selectTipoContato.click();
      selectTipoContato.focus();
      await delay(300);

      // Encontra e clica na opção "Celular"
      const celularOption = document.querySelector('#CELULAR');
      const celularItem = celularOption?.closest('.br-item');

      if (celularItem) {
        celularItem.click();
        log('Selecionou Celular no dropdown');
        await delay(500);
      } else if (celularOption) {
        celularOption.click();
        log('Clicou diretamente no input Celular');
        await delay(500);
      }
    }

    await waitForStableUI();

    // PASSO 2: Digitar o número no campo de valor
    log('Digitando número no campo de valor...');
    const valorInput = document.querySelector('#valorContatoInteressado');

    if (valorInput) {
      valorInput.focus();
      // Aguarda o input ser habilitado
      await delay(300);
      setNativeValue(valorInput, celular);
      log('Número digitado:', celular);
      await delay(500);
    }

    await waitForStableUI();

    // PASSO 3: Clicar em Adicionar
    log('Clicando em Adicionar...');
    const btnAdicionar = Array.from(document.querySelectorAll('button.br-button')).find(
      btn => normalizeText(btn.textContent || '').includes('adicionar')
    );

    if (btnAdicionar) {
      btnAdicionar.click();
      log('Clicou em Adicionar');
      await delay(1000);
    }

    await waitForStableUI();

    // PASSO 4: Verificar se o contato apareceu na tabela
    const contatoNaTabela = Array.from(document.querySelectorAll('table tbody td')).find(
      td => td.textContent?.includes(celular) || td.textContent?.includes('9927-1876')
    );
    if (contatoNaTabela) {
      log('Contato confirmado na tabela!');
    }

    // PASSO 5: Clicar em Fechar
    log('Clicando em Fechar...');
    const btnFechar = Array.from(document.querySelectorAll('button.br-button')).find(
      btn => normalizeText(btn.textContent || '').includes('fechar')
    );

    if (btnFechar && isVisible(btnFechar)) {
      btnFechar.click();
      log('Clicou em Fechar');
      await delay(500);
    }

    await waitForStableUI();

    log('Contato preenchido e modal fechado');
    // NÃO avança - segue para responderPerguntasAdicionais
  }

  async function responderPerguntasAdicionais() {
    setStatus('Respondendo perguntas adicionais');
    await waitForStableUI();

    // 1. Clica em "Sim" para acompanhar processo
    const acompanharSimSpan = document.querySelector('#acompanharProcesso-Sim')?.closest('.br-tag')
      || document.querySelector('.acompanharAndamento .br-tag.sim');
    const acompanharSimInput = document.querySelector('#acompanharProcesso-Sim');

    if (acompanharSimSpan && !acompanharSimInput?.checked) {
      acompanharSimSpan.click();
      await delay(200);
    } else if (acompanharSimInput && !acompanharSimInput.checked) {
      acompanharSimInput.click();
      await delay(200);
    }

    await waitForStableUI();

    // Helper para selecionar opção em br-select via radio
    async function selectBrSelectOption(inputSelector, optionText) {
      try {
        const input = document.querySelector(inputSelector);
        if (!input) {
          log('Input nao encontrado:', inputSelector);
          return false;
        }

        // Abre o dropdown
        input.focus();
        input.click();
        await delay(150);

        const toggleBtn = input.parentElement?.querySelector('button');
        if (toggleBtn) toggleBtn.click();
        await delay(150);

        // Encontra a lista
        const listId = input.getAttribute('aria-controls');
        let list = listId ? document.getElementById(listId) : null;
        if (!list) {
          list = input.closest('.br-select')?.querySelector('.br-list');
        }

        if (!list) {
          log('Lista nao encontrada para', inputSelector);
          return false;
        }

        // Força exibição
        list.style.cssText += '; display:block !important;';
        await delay(100);

        // Busca o radio pela opção
        const optionNorm = normalizeText(optionText);
        const items = Array.from(list.querySelectorAll('.br-item, [role="option"]'));
        let radio = null;

        for (const item of items) {
          const itemText = normalizeText(item.textContent || '');
          const itemRadio = item.querySelector('input[type="radio"]');
          if (itemRadio && (normalizeText(itemRadio.value || '').includes(optionNorm) || itemText.includes(optionNorm))) {
            radio = itemRadio;
            const brItem = radio.closest('.br-item');
            if (brItem) brItem.click();
            radio.click();
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            log('Selecionado:', optionText, 'em', inputSelector);
            break;
          }
        }

        // IMPORTANTE: Fechar o dropdown após selecionar
        await delay(100);

        // 1. Tenta Escape para fechar
        const escapeEvent = new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
        });
        input.dispatchEvent(escapeEvent);

        // 2. Remove o display:block forçado
        list.style.display = '';

        // 3. Seta aria-expanded para false
        input.setAttribute('aria-expanded', 'false');

        // 4. Tira o foco do input para fechar o dropdown
        input.blur();

        await delay(200);

        return !!radio;
      } catch (e) {
        log('Erro ao selecionar', optionText, 'em', inputSelector, ':', e.message);
        return false;
      }
    }

    // 2. "Você é estrangeiro..." -> B) Não
    // O ID muda dinamicamente, então buscamos pela label
    const estrangeiroDiv = Array.from(document.querySelectorAll('[id^="div-ca-"]')).find(div =>
      normalizeText(div.textContent || '').includes('estrangeiro')
    );
    if (estrangeiroDiv) {
      const estrangeiroInput = estrangeiroDiv.querySelector('input[role="combobox"]');
      if (estrangeiroInput) {
        await selectBrSelectOption('#' + estrangeiroInput.id, 'B) Não');
      }
    }

    // 3. "Deseja cadastrar Representante Legal?" -> Não
    const representanteDiv = Array.from(document.querySelectorAll('[id^="div-ca-"]')).find(div =>
      normalizeText(div.textContent || '').includes('representante legal')
    );
    if (representanteDiv) {
      const representanteInput = representanteDiv.querySelector('input[role="combobox"]');
      if (representanteInput) {
        await selectBrSelectOption('#' + representanteInput.id, 'Não');
      }
    }

    // 4. "Deseja cadastrar Procurador?" -> Sim
    const procuradorDiv = Array.from(document.querySelectorAll('[id^="div-ca-"]')).find(div =>
      normalizeText(div.textContent || '').includes('cadastrar procurador')
    );
    if (procuradorDiv) {
      const procuradorInput = procuradorDiv.querySelector('input[role="combobox"]');
      if (procuradorInput) {
        await selectBrSelectOption('#' + procuradorInput.id, 'Sim');
        await delay(300);

        // Após marcar Sim, aparece a checkbox e o campo de CPF
        // Marca a checkbox de concordância
        const checkboxProcurador = document.querySelector('.checkboxCampoAdicional input[type="checkbox"]');
        if (checkboxProcurador && !checkboxProcurador.checked) {
          checkboxProcurador.click();
          await delay(100);
        }

        // Preenche o CPF do procurador - 656.238.275-00
        const cpfProcuradorInput = Array.from(document.querySelectorAll('[id^="ca-"]')).find(el =>
          el.tagName === 'INPUT' &&
          el.type === 'text' &&
          normalizeText(el.closest('[id^="div-ca-"]')?.textContent || '').includes('cpf')
        );
        if (cpfProcuradorInput) {
          setNativeValue(cpfProcuradorInput, '656.238.275-00');
          log('CPF do procurador preenchido');
        }
      }
    }

    // 5. "Onde você mora?" -> Moro em residência
    const moraDiv = Array.from(document.querySelectorAll('[id^="div-ca-"]')).find(div =>
      normalizeText(div.textContent || '').includes('onde voce mora')
    );
    if (moraDiv) {
      const moraInput = moraDiv.querySelector('input[role="combobox"]');
      if (moraInput) {
        await selectBrSelectOption('#' + moraInput.id, 'Moro em residência');
      }
    }

    // 6. "Recebe algum tipo de benefício?" -> D) Não
    const beneficioDiv = Array.from(document.querySelectorAll('[id^="div-ca-"]')).find(div =>
      normalizeText(div.textContent || '').includes('recebe algum tipo de beneficio')
    );
    if (beneficioDiv) {
      const beneficioInput = beneficioDiv.querySelector('input[role="combobox"]');
      if (beneficioInput) {
        await selectBrSelectOption('#' + beneficioInput.id, 'D) Não');
      }
    }

    // 7. "autoriza o INSS a alterar a data..." -> Não
    const alterarDataDiv = Array.from(document.querySelectorAll('[id^="div-ca-"]')).find(div =>
      normalizeText(div.textContent || '').includes('autoriza o inss a alterar')
    );
    if (alterarDataDiv) {
      const alterarDataInput = alterarDataDiv.querySelector('input[role="combobox"]');
      if (alterarDataInput) {
        await selectBrSelectOption('#' + alterarDataInput.id, 'Não');
      }
    }

    await waitForStableUI();

    // 5.5 "Forma de Convívio" -> Com pessoas da família
    const convivioDiv = Array.from(document.querySelectorAll('[id^="div-ca-"]')).find(div =>
      normalizeText(div.textContent || '').includes('forma de convivio')
    );
    if (convivioDiv) {
      const convivioInput = convivioDiv.querySelector('input[role="combobox"]');
      if (convivioInput) {
        await selectBrSelectOption('#' + convivioInput.id, 'Com pessoas da família');
      }
    }

    // Nota: O campo de anexos será preenchido manualmente pelo usuário
    // A extensão não faz upload automático de arquivos

    // NÃO AVANÇA - PAUSA para o usuário anexar documentos
    setStatus('Perguntas preenchidas - ANEXE OS DOCUMENTOS e clique Avançar manualmente', { persistBanner: true });
    log('Perguntas adicionais preenchidas. Aguardando usuario anexar documentos e clicar Avancar...');

    // Aguarda até que a tela mude (detecta tela de CEP)
    const startTime = Date.now();
    const maxWait = 600000; // 10 minutos para anexar

    while (Date.now() - startTime < maxWait) {
      await waitForStableUI({ timeout: 2000 });

      // Verifica se mudou para a tela de CEP
      const cepInput = document.querySelector('input[placeholder*="CEP"], input[placeholder*="___-___"]');
      const selecionarUnidadeDiv = document.querySelector('.SelecionarUnidade');

      if (cepInput || selecionarUnidadeDiv) {
        log('Tela de CEP detectada. Continuando automacao...');
        hideBanner();
        return;
      }

      // Verifica se ainda está na tela de dados adicionais
      const anexosDiv = document.querySelector('.componenteAnexos');
      if (!anexosDiv) {
        log('Saiu da tela de dados adicionais. Continuando...');
        hideBanner();
        return;
      }

      await delay(1000);
    }

    log('Timeout aguardando usuario anexar documentos');
    hideBanner();
  }

  async function preencherCEP(config) {
    setStatus('Preenchendo CEP e buscando unidade');
    await waitForStableUI();

    // Detecta se está na tela de CEP
    const cepInput = document.querySelector('input.inputBRElement[placeholder*="___-___"], input[placeholder*="CEP"]');
    if (!cepInput) {
      log('Tela de CEP nao detectada, pulando...');
      return;
    }

    // Mostra modal para escolher a cidade
    const cidadeEscolhida = await new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.id = 'inss-cidade-modal';
      modal.innerHTML = `
        <div style="
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.5);
          z-index: 2147483646;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: Arial, sans-serif;
        ">
          <div style="
            background: white;
            border-radius: 8px;
            padding: 24px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
          ">
            <h2 style="margin: 0 0 16px 0; color: #003399; font-size: 18px;">
              📍 Escolha a Cidade
            </h2>
            
            <p style="margin: 0 0 16px 0; color: #333; font-size: 14px;">
              Selecione a cidade para buscar a agência do INSS:
            </p>
            
            <div style="display: flex; flex-direction: column; gap: 10px;">
              <button id="inss-cidade-ita" style="
                padding: 14px;
                font-size: 14px;
                border: 2px solid #003399;
                background: white;
                color: #003399;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
              ">🏙️ Itapetinga (CEP 45.700-000)</button>
              
              <button id="inss-cidade-vca" style="
                padding: 14px;
                font-size: 14px;
                border: 2px solid #003399;
                background: white;
                color: #003399;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
              ">🏙️ Vitória da Conquista (CEP 45.026-250)</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      document.getElementById('inss-cidade-ita').addEventListener('click', () => {
        modal.remove();
        resolve('ita');
      });

      document.getElementById('inss-cidade-vca').addEventListener('click', () => {
        modal.remove();
        resolve('vca');
      });
    });

    log('Cidade escolhida:', cidadeEscolhida);

    const cepValue = cidadeEscolhida === 'ita' ? '45.700-000' :
      cidadeEscolhida === 'vca' ? '45.026-250' : '';

    if (!cepValue) {
      log('Cidade nao configurada, CEP nao preenchido');
      return;
    }

    // Preenche o CEP
    setNativeValue(cepInput, cepValue);
    await delay(200);

    // Clica no botão Buscar
    const buscarBtn = Array.from(document.querySelectorAll('button.br-button.primary')).find(btn =>
      normalizeText(btn.textContent || '').includes('buscar')
    ) || document.querySelector('.SelecionarUnidade button.br-button.primary');

    if (buscarBtn) {
      log('Clicando em Buscar CEP');
      buscarBtn.click();

      // Aguarda o loading desaparecer e as agências carregarem
      await waitForStableUI({ timeout: 15000 });
      await delay(500);
    }

    log('CEP preenchido e busca iniciada');
  }

  function detectCurrentStep() {
    const servInput = document.querySelector('#idSelecionarServico');
    if (servInput) {
      const val = (servInput.value || '').trim().toLowerCase();
      if (!val || val.length < 3) return 'servico-pendente';
      if (val.includes('benef')) return 'servico-ok';
      return 'servico-pendente';
    }
    if (document.querySelector('[id="idRequerente.cpf"], input[id^="idRequerente\\.cpf"]')) {
      return 'cpf';
    }
    return 'init';
  }

  async function selecionarAgencia(config) {
    setStatus('Selecionando agencia');
    await waitForStableUI();

    const targetText = config.cidade === 'ita' ? 'AGENCIA ITAPETINGA' :
      config.cidade === 'vca' ? 'AGENCIA VITORIA DA CONQUISTA' : '';

    if (!targetText) {
      log('Cidade nao configurada, agencia nao selecionada');
      const btnNext = await waitForElement('#btn-next');
      await clickAndWait(btnNext, 'Avancar agencia');
      return;
    }

    // Aguarda as agências carregarem (podem vir do CEP)
    await delay(500);

    // Busca todas as unidades/agências
    const unidades = document.querySelectorAll('.unidade, .br-card .unidade');
    log('Encontradas', unidades.length, 'unidades');

    let found = false;
    for (const unidade of unidades) {
      const nomeEl = unidade.querySelector('.nome');
      const nome = normalizeText(nomeEl?.textContent || unidade.textContent || '');

      if (nome.includes(normalizeText(targetText))) {
        log('Agencia encontrada:', nomeEl?.textContent || targetText);
        unidade.click();
        await delay(200);

        // Verifica se ficou selecionada
        if (unidade.classList.contains('selected')) {
          log('Agencia selecionada com sucesso');
          found = true;
        } else {
          // Tenta clicar novamente
          unidade.click();
          await delay(100);
          found = unidade.classList.contains('selected');
        }
        break;
      }
    }

    if (!found) {
      log('AVISO: Agencia nao encontrada ou nao selecionada:', targetText);
    }

    await delay(300);
    const btnNext = await waitForElement('#btn-next');
    await clickAndWait(btnNext, 'Avancar agencia');
  }

  async function confirmarRequerimento() {
    setStatus('Confirmando requerimento');
    await waitForStableUI();

    // Marca a checkbox de confirmação
    const confirmarCheckbox = document.querySelector('#campo-declaracaoConfirmar');
    if (confirmarCheckbox && !confirmarCheckbox.checked) {
      confirmarCheckbox.click();
      await delay(100);
    }

    const btnNext = await waitForElement('#btn-next');
    await clickAndWait(btnNext, 'Finalizar requerimento');
  }

  async function runBPCFlow(config) {
    log('Inicio da automacao BPC com config:', config);
    if (state.running) {
      log('Automacao ja em execucao; continuando a partir do passo detectado.');
    }
    state.running = true;
    state.pauseReason = '';
    hideBanner();

    const cfg = {
      cpf: config?.cpf || '',
      celular: config?.celular || '',
      cidade: config?.cidade || ''
    };
    window.__inssPendingConfig = { ...cfg, autoStart: true };

    try {
      await handleErrorScreenIfAny();
      await waitForStableUI();
      // Detecta passo atual pelo DOM se possivel
      progress.step = detectCurrentStep() || progress.step;
      log('Passo detectado:', progress.step);

      const servInput = document.querySelector('#idSelecionarServico');
      const estouNoWizard = !!document.querySelector('#wizardNovoRequerimento') || !!servInput;

      if (progress.step === 'servico-pendente' || progress.step === 'init') {
        if (!servInput) {
          await goToNovoRequerimento();
          await waitForElement('#idSelecionarServico');
        }
        log('Na tela de servico; vou selecionar sem reabrir Novo Requerimento.');
        await escolherServico();
      } else if (progress.step === 'servico-ok') {
        log('Servico ja selecionado; avancando para CPF.');
        await clickNextIfPossible();
        await preencherCPF(cfg.cpf);
      } else if (progress.step === 'cpf') {
        await preencherCPF(cfg.cpf);
      }
      await autorizarCadunico();
      await preencherEstadoCivil();
      await responderGastos();
      await responderSwitches();
      await responderSUAS();
      await preencherContato(cfg.celular);
      await maybeHandleGrupoFamiliarManual();
      await responderPerguntasAdicionais();
      await preencherCEP(cfg);
      await selecionarAgencia(cfg);
      await confirmarRequerimento();
      setStatus('Automacao concluida', { persistBanner: true });
      alert('Automacao concluida!');
    } catch (err) {
      console.error(logPrefix, err);
      alert(`Erro na automacao: ${err.message || err}`);
    } finally {
      state.running = false;
      state.paused = false;
      state.resumeResolver = null;
      if (window.__inssPendingConfig) {
        window.__inssPendingConfig.autoStart = false;
      }
      hideBanner();
    }
  }

  function setupExigenciaShortcut() {
    function addGlobalStyle(css) {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    }

    const waitForHead = setInterval(() => {
      if (document.head || document.documentElement) {
        clearInterval(waitForHead);
        addGlobalStyle(`
          tr.dtp-table-wrapper-row { cursor: pointer !important; }
          tr.dtp-table-wrapper-row:hover { background-color: #f0f0f0 !important; }
        `);
      }
    }, 100);

    document.addEventListener('click', event => {
      const row = event.target.closest('tr.dtp-table-wrapper-row');
      if (!row) return;
      if (event.target.closest('button[aria-label="Gerar Comprovante"]') || event.target.closest('.fa-print')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const protocolo = row.cells?.[0]?.innerText?.trim();
      if (protocolo) {
        const novaUrl = `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/${protocolo}?auto_tab=exigencia`;
        log('Abrindo tarefa em nova aba com aba Exigencia', protocolo);
        window.open(novaUrl, '_blank');
      }
    }, true);

    async function activateExigenciaTab() {
      if (!window.location.href.includes('/tarefas/detalhar_tarefa/') || !window.location.href.includes('auto_tab=exigencia')) return;
      setStatus('Ativando aba Exigencia');
      const start = Date.now();
      while (Date.now() - start < 15000) {
        await waitForStableUI({ timeout: 5000 });
        const abaExigencia = document.querySelector('a[href="#exigencia"], a[aria-controls="exigencia"]');
        if (abaExigencia) {
          const parentLi = abaExigencia.parentElement;
          if (!parentLi?.classList.contains('active')) {
            abaExigencia.click();
            log('Aba Exigencia clicada');
          }
          return;
        }
        await delay(400);
      }
      log('Nao foi possivel ativar a aba Exigencia dentro do tempo limite.');
    }

    activateExigenciaTab().catch(err => log('Erro ao ativiar aba Exigencia', err));
  }

  window.inssAutoStart = runBPCFlow;

  setupExigenciaShortcut();

  // ==================== AUTO-DETECÇÃO E MODAL ====================

  // Cria e mostra o modal para pedir o CPF
  function showCPFModal() {
    // Remove modal anterior se existir
    const existing = document.getElementById('inss-auto-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'inss-auto-modal';
    modal.innerHTML = `
      <div style="
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5);
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: Arial, sans-serif;
      ">
        <div style="
          background: white;
          border-radius: 8px;
          padding: 24px;
          max-width: 400px;
          width: 90%;
          box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        ">
          <h2 style="margin: 0 0 16px 0; color: #003399; font-size: 18px;">
            🤖 Automação BPC - INSS
          </h2>
          
          <p style="margin: 0 0 16px 0; color: #333; font-size: 14px;">
            Informe o CPF do requerente para iniciar a automação:
          </p>
          
          <input type="text" id="inss-modal-cpf" placeholder="000.000.000-00" style="
            width: 100%;
            padding: 12px;
            font-size: 16px;
            border: 2px solid #003399;
            border-radius: 4px;
            margin-bottom: 16px;
            box-sizing: border-box;
          " />
          
          <div style="display: flex; gap: 12px;">
            <button id="inss-modal-cancel" style="
              flex: 1;
              padding: 12px;
              font-size: 14px;
              border: 1px solid #ccc;
              background: #f5f5f5;
              border-radius: 4px;
              cursor: pointer;
            ">Cancelar</button>
            
            <button id="inss-modal-start" style="
              flex: 1;
              padding: 12px;
              font-size: 14px;
              border: none;
              background: #003399;
              color: white;
              border-radius: 4px;
              cursor: pointer;
              font-weight: bold;
            ">Iniciar ▶</button>
          </div>
          
          <p style="margin: 16px 0 0 0; color: #666; font-size: 12px; text-align: center;">
            ⚠️ A automação pausará na etapa do CEP para você escolher a cidade.
          </p>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const cpfInput = document.getElementById('inss-modal-cpf');
    const cancelBtn = document.getElementById('inss-modal-cancel');
    const startBtn = document.getElementById('inss-modal-start');

    // Formata CPF enquanto digita
    cpfInput.addEventListener('input', (e) => {
      let value = e.target.value.replace(/\D/g, '');
      if (value.length > 11) value = value.substring(0, 11);
      if (value.length > 9) {
        value = value.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
      } else if (value.length > 6) {
        value = value.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
      } else if (value.length > 3) {
        value = value.replace(/(\d{3})(\d{1,3})/, '$1.$2');
      }
      e.target.value = value;
    });

    cancelBtn.addEventListener('click', () => {
      modal.remove();
    });

    startBtn.addEventListener('click', () => {
      const cpf = cpfInput.value.trim();
      if (!cpf || cpf.length < 14) {
        cpfInput.style.borderColor = 'red';
        cpfInput.focus();
        return;
      }

      modal.remove();

      // Inicia automação com valores padrão
      runBPCFlow({
        cpf: cpf,
        celular: '(77) 9 9927-1876', // Padrão
        cidade: 'ita' // Padrão - será perguntado novamente na etapa CEP
      });
    });

    cpfInput.focus();
  }

  // Detecta se está na tela de seleção de serviço
  function checkForServiceScreen() {
    // Verifica se está em /requerimentos
    if (!window.location.href.includes('/requerimentos')) return false;

    // Verifica se o seletor de serviço está visível e vazio
    const serviceInput = document.querySelector('#idSelecionarServico');
    if (serviceInput && isVisible(serviceInput)) {
      const value = (serviceInput.value || '').trim();
      if (!value || !normalizeText(value).includes('beneficio')) {
        return true;
      }
    }

    return false;
  }

  // Auto-detecção após a página carregar
  function setupAutoDetection() {
    // Aguarda um pouco para a página estabilizar
    setTimeout(() => {
      // Só mostra se não houver automação em andamento
      if (state.running) return;

      // Só mostra se já não foi mostrado recentemente
      if (window.__inssModalShown) return;

      if (checkForServiceScreen()) {
        log('Tela de selecao de servico detectada. Mostrando modal de CPF.');
        window.__inssModalShown = true;
        showCPFModal();
      }
    }, 2000);
  }

  // Inicia auto-detecção
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAutoDetection);
  } else {
    setupAutoDetection();
  }

  // Auto-retomar se houver configuração pendente persistida no window (após navegação).
  if (window.__inssPendingConfig && window.__inssPendingConfig.autoStart) {
    log('Config pendente detectada, retomando automacao automaticamente.');
    runBPCFlow(window.__inssPendingConfig);
  }
})();
