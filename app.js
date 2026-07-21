/* ==========================================================================
   LÓGICA PRINCIPAL (app.js) - TarifarioTuRed PWA
   Implementación Offline-First con Firebase / Fallback Local Mock
   ========================================================================== */

import firebaseConfig from './config.js';

// Importaciones dinámicas del SDK de Firebase desde CDN
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  signOut, 
  onAuthStateChanged,
  updatePassword as firebaseUpdatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  deleteDoc,
  getDoc, 
  getDocs, 
  query,
  where
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';

// --- ESTADO GLOBAL DE LA APP ---
let db = null;
let auth = null;
let currentUser = null;
let currentTechData = { nombre: 'Técnico de Campo', empresa: 'TuRed', email: '' };
let isMockMode = false;
let isAdmin = false;
let tarifario = [];
let cartItems = [];
let selectedPaymentMethod = 'contado'; // 'contado' o 'cuotas'
let cobroEfectivo = 0;
let cobroTransferencia = 0;
let allAdminComprobantes = [];
let allTechNames = {};
let clientesCache = null; // Cache de clientes en memoria (cargado de localStorage o Firestore)

// Tarifario por defecto (Fallback Offline / Mock)
const defaultTarifario = [
  // Servicios
  { id: 'inst_general', codigo: 'INST-001', nombre: 'Instalación General', categoria: 'Servicios', precio: 45000, unidad: 'servicio' },
  { id: 'inst_referido', codigo: 'INST-002', nombre: 'Instalación Referido', categoria: 'Servicios', precio: 33750, unidad: 'servicio' },
  { id: 'serv_mudanza', codigo: 'SRV-003', nombre: 'Mudanza', categoria: 'Servicios', precio: 10000, unidad: 'servicio' },
  { id: 'serv_reconexion', codigo: 'SRV-004', nombre: 'Reconexión', categoria: 'Servicios', precio: 10000, unidad: 'servicio' },
  { id: 'serv_tecnico', codigo: 'SRV-005', nombre: 'Servicio Técnico', categoria: 'Servicios', precio: 8000, unidad: 'servicio' },
  // Materiales
  { id: 'mat_router', codigo: 'MAT-001', nombre: 'Compra de Router', categoria: 'Materiales', precio: 45000, unidad: 'unidad', cuotas: [{ cantidad: 2, monto: 22500 }] },
  { id: 'mat_tvbox', codigo: 'MAT-002', nombre: 'Compra de TvBox', categoria: 'Materiales', precio: 50000, unidad: 'unidad', cuotas: [{ cantidad: 3, monto: 22000 }] },
  { id: 'mat_transformador', codigo: 'MAT-003', nombre: 'Transformador de Router o TvBox', categoria: 'Materiales', precio: 10000, unidad: 'unidad' },
  { id: 'mat_control', codigo: 'MAT-004', nombre: 'Control Remoto de TvBox', categoria: 'Materiales', precio: 10000, unidad: 'unidad' },
  { id: 'mat_cable', codigo: 'MAT-005', nombre: 'Metro de Cable', categoria: 'Materiales', precio: 500, unidad: 'metro' }
];

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  initNetworkMonitoring();
  initFirebaseOrMock();
  initRouter();
  setupEventListeners();
  setupInstallModalEvents();
  initPWAInstallPrompt();
});

// --- 1. CAPA DE CONEXIÓN Y RED (Fase L - Link) ---

function initNetworkMonitoring() {
  const banner = document.getElementById('network-status');
  const text = document.getElementById('network-text');

  const updateStatus = () => {
    if (navigator.onLine) {
      banner.classList.remove('offline');
      banner.classList.add('online');
      text.textContent = 'Conectado (En línea)';
      // Disparar sincronización si volvemos a estar online
      syncOfflineComprobantes();
    } else {
      banner.classList.remove('online');
      banner.classList.add('offline');
      text.textContent = 'Modo Sin Conexión (Offline)';
    }
  };

  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus(); // Estado inicial

  // Sync al cargar la app: capturar comprobantes pendientes de sesiones anteriores
  // y también los que quedaron "sincronizados" localmente sin llegar a Firestore
  setTimeout(() => {
    if (navigator.onLine && !isMockMode) {
      syncOfflineComprobantes();
    }
    // Precargar cache de clientes en background (para lookup offline)
    preloadClientesCache();
  }, 2000);
}

function initFirebaseOrMock() {
  // Comprobar si las credenciales son las por defecto "TU_API_KEY"
  if (!firebaseConfig || firebaseConfig.apiKey === 'TU_API_KEY') {
    enableMockMode('Credenciales de Firebase no configuradas. Usando Modo Demo Local.');
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);

    console.log('Firebase inicializado correctamente.');
  } catch (error) {
    console.error('Error al inicializar Firebase:', error);
    enableMockMode('Error al conectar con Firebase. Iniciando Modo Demo.');
  }
}

function enableMockMode(reason) {
  isMockMode = true;
  console.log(`%c[MODO DEMO] ${reason}`, 'color: #f59e0b; font-weight: bold; font-size: 1.1em;');
  
  // Agregar un distintivo en la interfaz para avisar al técnico
  const badge = document.createElement('div');
  badge.id = 'demo-badge';
  badge.innerHTML = '⚠️ MODO DEMO LOCAL';
  badge.style.cssText = 'position: fixed; bottom: 10px; right: 10px; background: #f59e0b; color: #000; padding: 5px 10px; font-size: 11px; font-weight: bold; border-radius: 4px; z-index: 10000; pointer-events: none; opacity: 0.85;';
  document.body.appendChild(badge);
  
  // Intentar cargar tarifas.json primero, fallback a defaults
  fetch('./tarifas.json')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && data.length > 0) {
        tarifario = data;
        console.log(`[MODO DEMO] Tarifario cargado desde tarifas.json (${data.length} ítems)`);
      } else {
        tarifario = [...defaultTarifario];
      }
      updateTarifarioDropdown();
    })
    .catch(() => {
      tarifario = [...defaultTarifario];
      updateTarifarioDropdown();
  });
}

// --- RENDICIÓN DE CAJA (VISTA ADMIN) ---

async function loadRendicionCaja() {
  const tbody = document.getElementById('caja-body');
  if (!tbody) return;

  // Establecer rango por defecto: últimos 30 días si no hay fechas seleccionadas
  const filterDateFrom = document.getElementById('caja-filter-from');
  const filterDateTo = document.getElementById('caja-filter-to');
  if (filterDateFrom && filterDateTo && !filterDateFrom.value && !filterDateTo.value) {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - 30);
    filterDateFrom.value = from.toISOString().split('T')[0];
    filterDateTo.value = today.toISOString().split('T')[0];
  }

  tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="padding: 2rem;">Cargando comprobantes...</td></tr>`;

  let comprobantes = [];

  if (isMockMode) {
    const saved = localStorage.getItem('mock_comprobantes');
    if (saved) {
      comprobantes = JSON.parse(saved).map(c => ({
        ...c,
        _techName: currentTechData.nombre || 'Técnico',
        cliente_nombre_search: c.cliente?.nombre || ''
      }));
    }
  } else {
    try {
      const snapshot = await getDocs(collection(db, 'comprobantes'));
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        comprobantes.push({
          ...data,
          _techName: allTechNames[data.tecnico_uid] || data.tecnico_nombre || 'Desconocido',
          cliente_nombre_search: data.cliente?.nombre || ''
        });
      });
    } catch (e) {
      console.error('Error cargando comprobantes para caja:', e);
      tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="color: var(--accent-danger)">Error al cargar comprobantes.</td></tr>`;
      return;
    }
  }

  // Aplicar filtros
  const filterTech = document.getElementById('caja-filter-tech');

  let filtered = [...comprobantes];

  if (filterDateFrom && filterDateFrom.value) {
    const from = new Date(filterDateFrom.value + 'T00:00:00');
    filtered = filtered.filter(c => new Date(c.fecha_creacion) >= from);
  }
  if (filterDateTo && filterDateTo.value) {
    const to = new Date(filterDateTo.value + 'T23:59:59');
    filtered = filtered.filter(c => new Date(c.fecha_creacion) <= to);
  }
  if (filterTech && filterTech.value) {
    filtered = filtered.filter(c => c.tecnico_uid === filterTech.value);
  }

  // Poblar filtro de técnicos
  if (filterTech) {
    const uniqueTechs = [...new Set(comprobantes.map(c => c.tecnico_uid))];
    const currentVal = filterTech.value;
    filterTech.innerHTML = '<option value="">Todos los técnicos</option>';
    uniqueTechs.forEach(uid => {
      const name = allTechNames[uid] || uid;
      filterTech.innerHTML += `<option value="${escapeHtml(uid)}">${escapeHtml(name)}</option>`;
    });
    filterTech.value = currentVal;
  }

  // Calcular resumen
  renderCajaSummary(filtered);

  // Renderizar tabla
  renderCajaTable(filtered);
}

function renderCajaSummary(comprobantes) {
  let totalEfectivo = 0;
  let totalTransferencia = 0;
  let totalCobrado = 0;
  let totalPendiente = 0;

  comprobantes.forEach(c => {
    if (c.metodo_cobro) {
      totalEfectivo += c.metodo_cobro.efectivo || 0;
      totalTransferencia += c.metodo_cobro.transferencia || 0;
      const pend = c.metodo_cobro.pendiente != null ? c.metodo_cobro.pendiente : Math.max(0, (c.total || 0) - (c.metodo_cobro.efectivo || 0) - (c.metodo_cobro.transferencia || 0));
      totalPendiente += pend;
    } else {
      totalEfectivo += c.total || 0;
    }
    totalCobrado += c.total || 0;
  });

  const summaryEl = document.getElementById('caja-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="caja-card">
        <div class="caja-card-value" style="color: var(--accent-success)">${formatCurrency(totalEfectivo)}</div>
        <div class="caja-card-label">Efectivo</div>
      </div>
      <div class="caja-card">
        <div class="caja-card-value" style="color: #3b82f6">${formatCurrency(totalTransferencia)}</div>
        <div class="caja-card-label">Transferencia</div>
      </div>
      <div class="caja-card">
        <div class="caja-card-value" style="color: var(--accent-danger)">${formatCurrency(totalPendiente)}</div>
        <div class="caja-card-label">Pendiente</div>
      </div>
      <div class="caja-card">
        <div class="caja-card-value" style="color: var(--accent-secondary)">${formatCurrency(totalEfectivo + totalTransferencia)}</div>
        <div class="caja-card-label">Total Cobrado</div>
      </div>
    `;
  }

  const countEl = document.getElementById('caja-count');
  if (countEl) {
    countEl.textContent = `${comprobantes.length} comprobante${comprobantes.length !== 1 ? 's' : ''}`;
  }
}

function renderCajaTable(comprobantes) {
  const tbody = document.getElementById('caja-body');
  if (!tbody) return;
  const state = adminState.caja;

  comprobantes.sort((a, b) => new Date(b.fecha_creacion) - new Date(a.fecha_creacion));

  // Guardar data para paginación
  state.fullData = comprobantes;

  // Aplicar búsqueda
  state.filteredData = filterByText(comprobantes, state.search, ['comprobante_id', '_techName', 'cliente_nombre_search']);
  const paginated = paginateData(state.filteredData, state.page, state.perPage);

  // Actualizar count
  const countEl = document.getElementById('admin-caja-count');
  if (countEl) {
    countEl.textContent = state.search
      ? `${paginated.totalItems} de ${comprobantes.length} comprobantes`
      : `${comprobantes.length} comprobantes`;
  }

  if (paginated.data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center">${state.search ? 'No se encontraron comprobantes con esa búsqueda.' : 'No se encontraron comprobantes para el rango seleccionado.'}</td></tr>`;
  } else {
    tbody.innerHTML = '';
    paginated.data.forEach(c => {
      const tr = document.createElement('tr');
      const badgeHtml = c.estado === 'sincronizado'
        ? '<span class="badge-sync badge-sync-online"><span class="badge-dot"></span>Sincronizado</span>'
        : '<span class="badge-sync badge-sync-offline"><span class="badge-dot"></span>Pendiente</span>';

      let cobroHtml = '<span class="badge-cobro badge-cobro-none">No reg.</span>';
      let efectivoVal = 0;
      let transferenciaVal = 0;
      let pendienteVal = 0;
      if (c.metodo_cobro) {
        efectivoVal = c.metodo_cobro.efectivo || 0;
        transferenciaVal = c.metodo_cobro.transferencia || 0;
        pendienteVal = c.metodo_cobro.pendiente != null ? c.metodo_cobro.pendiente : Math.max(0, (c.total || 0) - efectivoVal - transferenciaVal);
        if (pendienteVal > 0) {
          cobroHtml = `<span class="badge-cobro badge-cobro-pendiente">Pendiente</span>`;
        } else if (efectivoVal > 0 && transferenciaVal > 0) {
          cobroHtml = `<span class="badge-cobro badge-cobro-mixed">Mixto</span>`;
        } else if (transferenciaVal > 0) {
          cobroHtml = `<span class="badge-cobro badge-cobro-transferencia">Transferencia</span>`;
        } else {
          cobroHtml = `<span class="badge-cobro badge-cobro-efectivo">Efectivo</span>`;
        }
      } else {
        efectivoVal = c.total || 0;
      }

      tr.innerHTML = `
        <td data-label="Comprobante"><strong>${escapeHtml(c.comprobante_id.toUpperCase())}</strong></td>
        <td data-label="Técnico">${escapeHtml(c._techName)}</td>
        <td data-label="Cliente">${escapeHtml(c.cliente?.nombre) || '--'}</td>
        <td data-label="Fecha">${formatDate(c.fecha_creacion)}</td>
        <td data-label="Efectivo" class="text-right" style="color: var(--accent-success); font-weight: 600">${formatCurrency(efectivoVal)}</td>
        <td data-label="Transferencia" class="text-right" style="color: #3b82f6; font-weight: 600">${formatCurrency(transferenciaVal)}</td>
        <td data-label="Pendiente" class="text-right" style="color: ${pendienteVal > 0 ? 'var(--accent-danger)' : 'var(--accent-secondary)'}; font-weight: 600">${formatCurrency(pendienteVal)}</td>
        <td data-label="Total" class="text-right" style="font-weight: 600; color: var(--accent-secondary)">${formatCurrency(c.total)}</td>
        <td data-label="Cobro" class="text-center">${cobroHtml}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Paginación
  renderPaginationControls('admin-caja-pagination', paginated, (newPage) => {
    state.page = newPage;
    renderCajaTable(state.fullData);
  });
}

// --- 2. CAPA DE NAVEGACIÓN Y RUTAS (Fase A - Architect) ---

function initRouter() {
  const handleRoute = () => {
    const hash = window.location.hash || '#/panel';
    hideAllViews();

    if (hash === '#/login') {
      showView('view-login');
      resetLoginButton();
      checkLoginState(true); // Redirige al panel si ya está logueado
    } else if (hash === '#/panel') {
      checkLoginState(false, () => {
        showView('view-panel');
        loadTarifario();
        switchTab('service'); // Por defecto iniciar en la pestaña de carga
      });
    } else if (hash.startsWith('#/comprobante/')) {
      const parts = hash.split('/');
      const id = parts[parts.length - 1];
      showView('view-comprobante');
      loadComprobanteView(id);
    } else if (hash === '#/admin') {
      checkLoginState(false, () => {
        if (!isAdmin) {
          window.location.hash = '#/panel';
          return;
        }
        showView('view-admin');
        loadAdminTechs();
        loadAllComprobantes();
      });
    } else {
      // Redirección por defecto
      window.location.hash = '#/panel';
    }
  };

  window.addEventListener('hashchange', handleRoute);
  handleRoute(); // Carga de ruta inicial
}

function hideAllViews() {
  document.querySelectorAll('.app-view').forEach(view => view.classList.add('hidden'));
}

function showView(id) {
  const view = document.getElementById(id);
  if (view) view.classList.remove('hidden');
}

function checkLoginState(isOnLoginRoute, onAuthSuccessCallback) {
  if (isMockMode) {
    const session = localStorage.getItem('mock_session');
    if (session) {
      currentUser = JSON.parse(session);
      currentTechData = { nombre: currentUser.nombre, empresa: currentUser.empresa, email: currentUser.email };
      updateTechProfileUI();
      if (isOnLoginRoute) {
        window.location.hash = '#/panel';
      } else if (onAuthSuccessCallback) {
        onAuthSuccessCallback();
      }
    } else {
      if (!isOnLoginRoute) {
        window.location.hash = '#/login';
      }
    }
    return;
  }

  // Firebase Real Auth Listener
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;
      isAdmin = false;
      
      // Intentar recuperar los datos del técnico desde la colección usuarios de Firestore
      try {
        const userDoc = await getDoc(doc(db, 'usuarios', user.uid));
        if (userDoc.exists()) {
          const data = userDoc.data();
          currentTechData = {
            nombre: data.nombre || 'Técnico de Campo',
            empresa: data.empresa || 'TuRed',
            email: user.email
          };
          isAdmin = data.rol === 'admin';
        } else {
          currentTechData = { nombre: 'Técnico de Campo', empresa: 'TuRed', email: user.email };
        }
      } catch (e) {
        console.warn('No se pudo cargar datos adicionales del técnico (offline o sin permisos). Usando defaults.');
        currentTechData = { nombre: 'Técnico de Campo', empresa: 'TuRed', email: user.email };
      }
      
      updateTechProfileUI();
      updateAdminButton();
      if (isOnLoginRoute) {
        window.location.hash = '#/panel';
      } else if (onAuthSuccessCallback) {
        onAuthSuccessCallback();
      }
    } else {
      currentUser = null;
      isAdmin = false;
      updateAdminButton();
      if (!isOnLoginRoute) {
        window.location.hash = '#/login';
      }
    }
  });
}

function updateTechProfileUI() {
  document.getElementById('user-display-name').textContent = currentTechData.nombre;
  document.getElementById('user-display-company').textContent = currentTechData.empresa;
  
  // Rellenar avatares e iniciales
  const initials = currentTechData.nombre.charAt(0).toUpperCase();
  document.querySelectorAll('.avatar').forEach(avatar => avatar.textContent = initials);
}

function updateAdminButton() {
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn) {
    adminBtn.classList.toggle('hidden', !isAdmin);
  }
}

// --- 3. LÓGICA DE NEGOCIO Y OPERACIÓN (Fase A/S - Architect & Stylize) ---

// Setup de Event Listeners
function setupEventListeners() {
  // Login Form
  const loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', handleLogin);

  // Pestañas del Panel
  const tabBtnService = document.getElementById('tab-btn-service');
  const tabBtnHistory = document.getElementById('tab-btn-history');
  const btnRefreshHistory = document.getElementById('btn-refresh-history');

  if (tabBtnService && tabBtnHistory) {
    tabBtnService.addEventListener('click', () => switchTab('service'));
    tabBtnHistory.addEventListener('click', () => switchTab('history'));
  }
  if (btnRefreshHistory) {
    btnRefreshHistory.addEventListener('click', loadHistorialComprobantes);
  }

  // Logout Button
  const btnLogout = document.getElementById('btn-logout');
  btnLogout.addEventListener('click', handleLogout);

  // Controls del Carrito
  const btnQtyMinus = document.getElementById('btn-qty-minus');
  const btnQtyPlus = document.getElementById('btn-qty-plus');
  const inputQuantity = document.getElementById('item-quantity');

  btnQtyMinus.addEventListener('click', () => {
    let val = parseInt(inputQuantity.value) || 1;
    if (val > 1) inputQuantity.value = val - 1;
  });

  btnQtyPlus.addEventListener('click', () => {
    let val = parseInt(inputQuantity.value) || 1;
    inputQuantity.value = val + 1;
  });

  // Evento al cambiar ítem seleccionado
  const itemSelector = document.getElementById('item-selector');
  itemSelector.addEventListener('change', (e) => {
    const selectedId = e.target.value;
    const item = tarifario.find(t => t.id === selectedId);
    const pricePreview = document.getElementById('item-price-preview');
    const paymentContainer = document.getElementById('payment-method-container');
    const btnContado = document.getElementById('btn-pago-contado');
    const btnCuotas = document.getElementById('btn-pago-cuotas');
    const cuotasInfo = document.getElementById('cuotas-info');

    if (item) {
      pricePreview.value = formatCurrency(item.precio);

      // Mostrar selector de pago si el ítem tiene cuotas
      if (item.cuotas && item.cuotas.length > 0) {
        paymentContainer.classList.remove('hidden');
        // Reset a contado
        selectedPaymentMethod = 'contado';
        btnContado.classList.add('active');
        btnCuotas.classList.remove('active');
        cuotasInfo.classList.add('hidden');
      } else {
        paymentContainer.classList.add('hidden');
        selectedPaymentMethod = 'contado';
      }
    } else {
      pricePreview.value = '$0.00';
      paymentContainer.classList.add('hidden');
      selectedPaymentMethod = 'contado';
    }
  });

  // Botones de método de pago
  const btnContado = document.getElementById('btn-pago-contado');
  const btnCuotas = document.getElementById('btn-pago-cuotas');
  const cuotasInfo = document.getElementById('cuotas-info');

  btnContado.addEventListener('click', () => {
    selectedPaymentMethod = 'contado';
    btnContado.classList.add('active');
    btnCuotas.classList.remove('active');
    cuotasInfo.classList.add('hidden');
  });

  btnCuotas.addEventListener('click', () => {
    selectedPaymentMethod = 'cuotas';
    btnCuotas.classList.add('active');
    btnContado.classList.remove('active');
    // Mostrar info de cuotas del ítem seleccionado
    const selectedId = document.getElementById('item-selector').value;
    const item = tarifario.find(t => t.id === selectedId);
    if (item && item.cuotas && item.cuotas.length > 0) {
      const c = item.cuotas[0]; // Tomar la primera opción de cuotas
      cuotasInfo.textContent = `${c.cantidad} cuotas de ${formatCurrency(c.monto)} = ${formatCurrency(c.cantidad * c.monto)}`;
      cuotasInfo.classList.remove('hidden');
    }
  });

  // Botón Agregar Ítem
  const btnAddItem = document.getElementById('btn-add-item');
  btnAddItem.addEventListener('click', addItemToCart);

  // Botón Generar Comprobante
  const btnGenerateReceipt = document.getElementById('btn-generate-receipt');
  btnGenerateReceipt.addEventListener('click', generateComprobante);

  // Botón Volver al Panel
  const btnReceiptBack = document.getElementById('btn-receipt-back');
  btnReceiptBack.addEventListener('click', () => {
    window.location.hash = '#/panel';
  });

  // Botón Imprimir
  const btnReceiptPrint = document.getElementById('btn-receipt-print');
  btnReceiptPrint.addEventListener('click', () => {
    window.print();
  });
  
  // Validaciones del formulario de cliente para habilitar botón
  const clientName = document.getElementById('client-name');
  const clientAddress = document.getElementById('client-address');
  
  const validateForm = () => {
    const subtotal = cartItems.reduce((acc, curr) => acc + curr.subtotal, 0);
    const cobroValid = subtotal === 0 || (cobroEfectivo + cobroTransferencia >= 0);
    btnGenerateReceipt.disabled = !(clientName.value.trim() && clientAddress.value.trim() && cartItems.length > 0 && cobroValid);
  };
  
  clientName.addEventListener('input', validateForm);
  clientAddress.addEventListener('input', validateForm);

  // --- COBRO: Inputs de Método de Cobro (Efectivo / Transferencia) ---
  const inputCobroEfectivo = document.getElementById('cobro-efectivo');
  const inputCobroTransferencia = document.getElementById('cobro-transferencia');
  const cobroValidation = document.getElementById('cobro-validation');
  if (inputCobroEfectivo && inputCobroTransferencia) {
    const syncCobroFrom = (source) => {
      const subtotal = cartItems.reduce((acc, curr) => acc + curr.subtotal, 0);
      if (source === 'efectivo') {
        cobroEfectivo = Math.max(0, parseFloat(inputCobroEfectivo.value) || 0);
      } else {
        cobroTransferencia = Math.max(0, parseFloat(inputCobroTransferencia.value) || 0);
      }
      updateCobroValidation(subtotal);
      validateForm();
    };

    inputCobroEfectivo.addEventListener('input', () => syncCobroFrom('efectivo'));
    inputCobroTransferencia.addEventListener('input', () => syncCobroFrom('transferencia'));

    if (cobroValidation) {
      cobroValidation.addEventListener('click', () => {
        const subtotal = cartItems.reduce((acc, curr) => acc + curr.subtotal, 0);
        cobroEfectivo = subtotal;
        cobroTransferencia = 0;
        inputCobroEfectivo.value = subtotal > 0 ? subtotal : '';
        inputCobroTransferencia.value = '';
        updateCobroValidation(subtotal);
        validateForm();
      });
    }
  }

  // --- ADMIN: Pestañas ---
  const tabAdminTechs = document.getElementById('tab-admin-techs');
  const tabAdminComps = document.getElementById('tab-admin-comps');
  const tabAdminCaja = document.getElementById('tab-admin-caja');
  const tabAdminClients = document.getElementById('tab-admin-clients');
  const allAdminTabs = [tabAdminTechs, tabAdminComps, tabAdminCaja, tabAdminClients].filter(Boolean);
  const allAdminContainers = ['admin-techs-container', 'admin-comps-container', 'admin-caja-container', 'admin-clients-container'];

  function switchAdminTab(activeTab) {
    allAdminTabs.forEach(t => t.classList.remove('active'));
    activeTab.classList.add('active');
    allAdminContainers.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
  }

  if (tabAdminTechs) {
    tabAdminTechs.addEventListener('click', () => {
      switchAdminTab(tabAdminTechs);
      document.getElementById('admin-techs-container').classList.remove('hidden');
      adminState.techs.page = 1;
    });
  }
  if (tabAdminComps) {
    tabAdminComps.addEventListener('click', () => {
      switchAdminTab(tabAdminComps);
      document.getElementById('admin-comps-container').classList.remove('hidden');
      adminState.comps.page = 1;
    });
  }
  if (tabAdminCaja) {
    tabAdminCaja.addEventListener('click', () => {
      switchAdminTab(tabAdminCaja);
      document.getElementById('admin-caja-container').classList.remove('hidden');
      adminState.caja.page = 1;
      loadRendicionCaja();
    });
  }
  if (tabAdminClients) {
    tabAdminClients.addEventListener('click', () => {
      switchAdminTab(tabAdminClients);
      document.getElementById('admin-clients-container').classList.remove('hidden');
      adminState.clients.page = 1;
      renderAdminClients();
    });
  }

  // --- ADMIN: Crear Técnico ---
  const btnCreateTech = document.getElementById('btn-create-tech');
  if (btnCreateTech) {
    btnCreateTech.addEventListener('click', () => openTechModal());
  }

  // --- ADMIN: Modal Técnico ---
  const modalTech = document.getElementById('modal-tech');
  const formTech = document.getElementById('form-tech');
  const modalTechClose = document.getElementById('modal-tech-close');
  const modalTechCancel = document.getElementById('modal-tech-cancel');

  if (formTech) {
    formTech.addEventListener('submit', handleTechSubmit);
  }
  if (modalTechClose) modalTechClose.addEventListener('click', () => modalTech.classList.add('hidden'));
  if (modalTechCancel) modalTechCancel.addEventListener('click', () => modalTech.classList.add('hidden'));

  // --- ADMIN: Modal Contraseña ---
  const modalPassword = document.getElementById('modal-password');
  const formPassword = document.getElementById('form-password');
  const modalPasswordClose = document.getElementById('modal-password-close');
  const modalPasswordCancel = document.getElementById('modal-password-cancel');

  if (formPassword) {
    formPassword.addEventListener('submit', handlePasswordChange);
  }
  if (modalPasswordClose) modalPasswordClose.addEventListener('click', () => modalPassword.classList.add('hidden'));
  if (modalPasswordCancel) modalPasswordCancel.addEventListener('click', () => modalPassword.classList.add('hidden'));

  // --- ADMIN: Modal Confirmación ---
  const modalConfirmClose = document.getElementById('modal-confirm-close');
  const modalConfirmCancel = document.getElementById('modal-confirm-cancel');
  if (modalConfirmClose) modalConfirmClose.addEventListener('click', () => document.getElementById('modal-confirm').classList.add('hidden'));
  if (modalConfirmCancel) modalConfirmCancel.addEventListener('click', () => document.getElementById('modal-confirm').classList.add('hidden'));

  // --- ADMIN: Filtros de comprobantes ---
  const adminFilterTech = document.getElementById('admin-filter-tech');
  const adminFilterStatus = document.getElementById('admin-filter-status');
  const btnRefreshAdminComps = document.getElementById('btn-refresh-admin-comps');
  if (adminFilterTech) adminFilterTech.addEventListener('change', () => { adminState.comps.page = 1; loadAllComprobantes(); });
  if (adminFilterStatus) adminFilterStatus.addEventListener('change', () => { adminState.comps.page = 1; loadAllComprobantes(); });
  if (btnRefreshAdminComps) btnRefreshAdminComps.addEventListener('click', () => { adminState.comps.page = 1; loadAllComprobantes(); });

  // --- ADMIN: Filtros de Rendición de Caja ---
  const cajaFilterFrom = document.getElementById('caja-filter-from');
  const cajaFilterTo = document.getElementById('caja-filter-to');
  const cajaFilterTech = document.getElementById('caja-filter-tech');
  const btnRefreshCaja = document.getElementById('btn-refresh-caja');
  if (cajaFilterFrom) cajaFilterFrom.addEventListener('change', () => { adminState.caja.page = 1; loadRendicionCaja(); });
  if (cajaFilterTo) cajaFilterTo.addEventListener('change', () => { adminState.caja.page = 1; loadRendicionCaja(); });
  if (cajaFilterTech) cajaFilterTech.addEventListener('change', () => { adminState.caja.page = 1; loadRendicionCaja(); });
  if (btnRefreshCaja) btnRefreshCaja.addEventListener('click', () => { adminState.caja.page = 1; loadRendicionCaja(); });

  // --- ADMIN: Búsqueda en Técnicos ---
  const techsSearch = document.getElementById('admin-techs-search');
  if (techsSearch) {
    techsSearch.addEventListener('input', debounce(() => {
      adminState.techs.search = techsSearch.value;
      adminState.techs.page = 1;
      renderAdminTechsPage();
    }, 300));
  }

  // --- ADMIN: Búsqueda en Comprobantes ---
  const compsSearch = document.getElementById('admin-comps-search');
  if (compsSearch) {
    compsSearch.addEventListener('input', debounce(() => {
      adminState.comps.search = compsSearch.value;
      adminState.comps.page = 1;
      renderAdminComprobantes();
    }, 300));
  }

  // --- ADMIN: Búsqueda en Caja ---
  const cajaSearch = document.getElementById('admin-caja-search');
  if (cajaSearch) {
    cajaSearch.addEventListener('input', debounce(() => {
      adminState.caja.search = cajaSearch.value;
      adminState.caja.page = 1;
      renderCajaTable(adminState.caja.fullData);
    }, 300));
  }

  // --- ADMIN: Búsqueda en Clientes ---
  const clientsSearch = document.getElementById('admin-clients-search');
  if (clientsSearch) {
    clientsSearch.addEventListener('input', debounce(() => {
      adminState.clients.search = clientsSearch.value;
      adminState.clients.page = 1;
      renderClientsTable(loadClientesFromCache());
    }, 300));
  }

  // --- CLIENTES: Lookup por N° Cliente (debounced) ---
  const clientIdInput = document.getElementById('client-id');
  if (clientIdInput) {
    const doLookup = debounce(() => {
      const codigo = clientIdInput.value.trim();
      if (codigo.length < 3) return;
      const client = lookupClient(codigo);
      if (client) {
        document.getElementById('client-name').value = client.nombre || '';
        document.getElementById('client-address').value = client.domicilio || '';
        document.getElementById('client-phone').value = client.telefonos || '';
        document.getElementById('client-email').value = client.emails || '';
        // Visual feedback
        clientIdInput.style.borderColor = 'var(--accent-success)';
        setTimeout(() => { clientIdInput.style.borderColor = ''; }, 2000);
      }
    }, 400);
    clientIdInput.addEventListener('input', doLookup);
  }

  // --- ADMIN: Modal CSV Clientes ---
  const btnUploadCSV = document.getElementById('btn-upload-csv');
  const modalClientsCSV = document.getElementById('modal-clients-csv');
  const modalClientsClose = document.getElementById('modal-clients-csv-close');
  const modalClientsCancel = document.getElementById('modal-clients-csv-cancel');
  const csvFileInput = document.getElementById('csv-file-input');
  const csvPreview = document.getElementById('csv-preview');
  const csvUploadStatus = document.getElementById('csv-upload-status');

  if (btnUploadCSV && modalClientsCSV) {
    btnUploadCSV.addEventListener('click', () => {
      csvPreview.innerHTML = '';
      csvUploadStatus.classList.add('hidden');
      modalClientsCSV.classList.remove('hidden');
    });
  }
  if (modalClientsClose) modalClientsClose.addEventListener('click', () => modalClientsCSV.classList.add('hidden'));
  if (modalClientsCancel) modalClientsCancel.addEventListener('click', () => modalClientsCSV.classList.add('hidden'));

  if (csvFileInput) {
    csvFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      csvUploadStatus.classList.add('hidden');
      const text = await file.text();
      const clientsMap = parseClientCSV(text);
      const codes = Object.keys(clientsMap);
      if (codes.length === 0) {
        csvPreview.innerHTML = '<p style="color:var(--accent-danger)">No se encontraron clientes válidos en el CSV.</p>';
        return;
      }
      // Calcular tamaño del JSON string que se subirá
      const jsonString = JSON.stringify(clientsMap);
      const sizeKB = Math.round(new Blob([jsonString]).size / 1024);
      const sizeWarning = sizeKB > 900 ? '<p style="color:var(--accent-danger);font-size:0.8rem;margin-top:0.3rem;">⚠️ El archivo es grande. Firestore tiene un límite de 1024 KB por documento.</p>' : '';
      csvPreview.innerHTML = `
        <p><strong>${codes.length}</strong> clientes encontrados en el archivo.</p>
        <p style="color:var(--text-secondary);font-size:0.8rem;">Tamaño en Firestore: <strong>${sizeKB} KB</strong> / 1024 KB${sizeWarning}</p>
        <div style="max-height:200px;overflow-y:auto;margin:0.5rem 0;border:1px solid var(--border);border-radius:8px;padding:0.5rem;font-size:0.8rem;">
          ${codes.slice(0, 20).map(c => `<div><strong>${escapeHtml(c)}</strong> — ${escapeHtml(clientsMap[c].n || '')}</div>`).join('')}
          ${codes.length > 20 ? `<div style="color:var(--text-secondary);margin-top:0.3rem;">... y ${codes.length - 20} más</div>` : ''}
        </div>
        <button id="btn-confirm-csv-upload" class="btn btn-primary w-100 mt-2" ${sizeKB > 950 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
          <span id="csv-upload-btn-text">Subir ${codes.length} clientes a Firestore (${sizeKB} KB)</span>
          <div class="spinner hidden" id="csv-upload-spinner"></div>
        </button>
      `;
      if (sizeKB <= 950) {
        document.getElementById('btn-confirm-csv-upload').addEventListener('click', async () => {
          const btnText = document.getElementById('csv-upload-btn-text');
          const spinner = document.getElementById('csv-upload-spinner');
          btnText.classList.add('hidden');
          spinner.classList.remove('hidden');
          try {
            const result = await uploadClientsToFirestore(clientsMap);
            csvUploadStatus.className = '';
            csvUploadStatus.style.color = 'var(--accent-success)';
            csvUploadStatus.textContent = `✅ ${result.count} clientes subidos correctamente (${result.sizeKB} KB). 1 solo documento en Firestore.`;
            csvUploadStatus.classList.remove('hidden');
            renderAdminClients();
            setTimeout(() => { modalClientsCSV.classList.add('hidden'); }, 1500);
          } catch (err) {
            csvUploadStatus.className = '';
            csvUploadStatus.style.color = 'var(--accent-danger)';
            csvUploadStatus.textContent = `❌ Error: ${err.message}`;
            csvUploadStatus.classList.remove('hidden');
          } finally {
            btnText.classList.remove('hidden');
            spinner.classList.add('hidden');
          }
        });
      }
    });
  }

  // --- CSV Upload Zone: Drag & Drop + Click ---
  const csvUploadZone = document.getElementById('csv-upload-zone');
  const btnSelectCSV = document.getElementById('btn-select-csv');
  if (csvUploadZone && csvFileInput) {
    csvUploadZone.addEventListener('click', (e) => {
      if (e.target === btnSelectCSV || e.target.closest('#btn-select-csv')) return;
      csvFileInput.click();
    });
    if (btnSelectCSV) btnSelectCSV.addEventListener('click', () => csvFileInput.click());
    csvUploadZone.addEventListener('dragover', (e) => { e.preventDefault(); csvUploadZone.classList.add('drag-over'); });
    csvUploadZone.addEventListener('dragleave', () => csvUploadZone.classList.remove('drag-over'));
    csvUploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      csvUploadZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith('.csv')) {
        csvFileInput.files = e.dataTransfer.files;
        csvFileInput.dispatchEvent(new Event('change'));
      }
    });
  }
}

// Handler de Inicio de Sesión
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const spinner = document.getElementById('login-spinner');
  const btnText = document.querySelector('#btn-login span');
  const errorText = document.getElementById('login-error');

  errorText.classList.add('hidden');
  spinner.classList.remove('hidden');
  btnText.classList.add('hidden');

  if (isMockMode) {
    // Simular retraso de red
    setTimeout(() => {
      spinner.classList.add('hidden');
      btnText.classList.remove('hidden');

      if (email && password.length >= 4) {
        // Login mock exitoso
        const mockUser = {
          uid: 'mock_uid_123',
          email: email,
          nombre: email.split('@')[0].toUpperCase(),
          empresa: 'TuRed MOCK'
        };
        localStorage.setItem('mock_session', JSON.stringify(mockUser));
        currentUser = mockUser;
        currentTechData = { nombre: mockUser.nombre, empresa: mockUser.empresa, email: mockUser.email };
        updateTechProfileUI();
        window.location.hash = '#/panel';
      } else {
        errorText.textContent = 'Usuario o contraseña incorrectos (Mínimo 4 caracteres).';
        errorText.classList.remove('hidden');
      }
    }, 1000);
    return;
  }

  // Firebase Auth Real
  try {
    await signInWithEmailAndPassword(auth, email, password);
    // El listener onAuthStateChanged redirigirá automáticamente
  } catch (error) {
    console.error('Login error:', error);
    spinner.classList.add('hidden');
    btnText.classList.remove('hidden');
    
    let errMsg = 'Error al iniciar sesión. Verifique sus datos.';
    if (error.code === 'auth/invalid-credential') {
      errMsg = 'Credenciales incorrectas.';
    } else if (error.code === 'auth/network-request-failed') {
      errMsg = 'Error de conexión. Se requiere internet para el primer login.';
    }
    
    errorText.textContent = errMsg;
    errorText.classList.remove('hidden');
  }
}

// Handler de Cierre de Sesión
async function handleLogout() {
  if (isMockMode) {
    localStorage.removeItem('mock_session');
    currentUser = null;
    resetLoginButton();
    window.location.hash = '#/login';
    return;
  }

  try {
    resetLoginButton();
    await signOut(auth);
    window.location.hash = '#/login';
  } catch (error) {
    console.error('Error al cerrar sesión:', error);
  }
}

function resetLoginButton() {
  const spinner = document.getElementById('login-spinner');
  const btnText = document.querySelector('#btn-login span');
  if (spinner) spinner.classList.add('hidden');
  if (btnText) btnText.classList.remove('hidden');
}

// Carga de Tarifario
async function loadTarifario() {
  if (isMockMode) {
    // Ya está cargado en enableMockMode()
    return;
  }

  // 1. Intentar cargar desde tarifas.json (archivo editable local)
  try {
    const response = await fetch('./tarifas.json');
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        tarifario = data;
        console.log(`Tarifario cargado desde tarifas.json (${data.length} ítems)`);
        updateTarifarioDropdown();
        return;
      }
    }
  } catch (e) {
    console.warn('No se pudo cargar tarifas.json:', e);
  }

  // 2. Intentar cargar desde Firestore (si Firebase está configurado)
  if (db) {
    try {
      const querySnapshot = await getDocs(collection(db, 'tarifas'));
      const tempTarifas = [];
      querySnapshot.forEach((doc) => {
        tempTarifas.push({ id: doc.id, ...doc.data() });
      });

      if (tempTarifas.length > 0) {
        tarifario = tempTarifas;
        console.log(`Tarifario cargado desde Firestore (${tempTarifas.length} ítems)`);
        updateTarifarioDropdown();
        return;
      }
    } catch (error) {
      console.warn('Error al cargar tarifario de Firestore (offline).', error);
    }
  }

  // 3. Fallback: tarifas hardcoded
  console.log('Usando tarifas por defecto (hardcoded).');
  tarifario = [...defaultTarifario];
  updateTarifarioDropdown();
}

// Actualizar dropdown de tarifas
function updateTarifarioDropdown() {
  const selector = document.getElementById('item-selector');
  selector.innerHTML = '<option value="">-- Selecciona una opción --</option>';

  // Agrupar por categoría
  const categorias = [...new Set(tarifario.map(t => t.categoria))];

  categorias.forEach(cat => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = cat;

    const items = tarifario.filter(t => t.categoria === cat);
    items.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id;
      let label = `${item.codigo} - ${item.nombre} (${formatCurrency(item.precio)})`;
      if (item.cuotas && item.cuotas.length > 0) {
        const c = item.cuotas[0];
        label += ` - ${c.cantidad} cuotas de ${formatCurrency(c.monto)}`;
      }
      option.textContent = label;
      optgroup.appendChild(option);
    });

    selector.appendChild(optgroup);
  });
}

// Agregar Ítem al Presupuesto
function addItemToCart() {
  const selector = document.getElementById('item-selector');
  const selectedId = selector.value;
  const quantityInput = document.getElementById('item-quantity');
  const quantity = parseInt(quantityInput.value) || 1;

  if (!selectedId) {
    alert('Por favor selecciona un servicio o insumo de la lista.');
    return;
  }

  const item = tarifario.find(t => t.id === selectedId);
  if (!item) return;

  // Verificar si ya existe en el carrito
  const existingItemIndex = cartItems.findIndex(i => i.tarifa_id === item.id);

  if (existingItemIndex > -1) {
    // Sumar cantidad
    cartItems[existingItemIndex].cantidad += quantity;
    cartItems[existingItemIndex].subtotal = cartItems[existingItemIndex].cantidad * cartItems[existingItemIndex].precio_unitario;
  } else {
    // Crear nuevo ítem
    const cartItem = {
      item_index: cartItems.length,
      tarifa_id: item.id,
      codigo: item.codigo,
      nombre: item.nombre,
      cantidad: quantity,
      precio_unitario: item.precio,
      subtotal: quantity * item.precio,
      metodo_pago: selectedPaymentMethod,
      precio_contado: item.precio
    };

    // Si eligió cuotas, el precio que se cobra ahora es la cuota
    if (selectedPaymentMethod === 'cuotas' && item.cuotas && item.cuotas.length > 0) {
      const c = item.cuotas[0];
      cartItem.cuotas_info = c;
      cartItem.precio_unitario = c.monto;
      cartItem.subtotal = quantity * c.monto;
    }

    cartItems.push(cartItem);
  }

  // Reset del selector
  selector.value = '';
  quantityInput.value = 1;
  document.getElementById('item-price-preview').value = '$0.00';
  document.getElementById('payment-method-container').classList.add('hidden');
  selectedPaymentMethod = 'contado';

  updateCartTable();
}

// Actualizar Tabla del Carrito y Totales
function updateCartTable() {
  const cartBody = document.getElementById('cart-body');
  cartBody.innerHTML = '';

  if (cartItems.length === 0) {
    cartBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5" class="text-center">No hay ítems agregados a este presupuesto.</td>
      </tr>
    `;
    updateTotalsUI(0);
    return;
  }

  cartItems.forEach((item, index) => {
    const tr = document.createElement('tr');
    
    // Badge de método de pago
    let paymentBadge = '';
    if (item.metodo_pago === 'cuotas' && item.cuotas_info) {
      const totalCuotas = item.cuotas_info.cantidad * item.cuotas_info.monto;
      paymentBadge = `<span class="payment-method-badge badge-cuotas">1/${item.cuotas_info.cantidad} cuotas — Pendiente: ${formatCurrency(totalCuotas - item.cuotas_info.monto)}</span>`;
    } else {
      paymentBadge = `<span class="payment-method-badge badge-contado">Contado</span>`;
    }

    tr.innerHTML = `
      <td><strong>${escapeHtml(item.codigo)}</strong><br>${escapeHtml(item.nombre)}${paymentBadge}</td>
      <td class="text-center">${item.cantidad}</td>
      <td class="text-right">${formatCurrency(item.precio_unitario)}</td>
      <td class="text-right">${formatCurrency(item.subtotal)}</td>
      <td class="text-center">
        <button type="button" class="btn-delete" data-index="${index}" title="Eliminar ítem">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </td>
    `;
    cartBody.appendChild(tr);
  });

  // Asignar eventos de borrado
  document.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-index'));
      cartItems.splice(idx, 1);
      // Reindexar
      cartItems.forEach((item, i) => item.item_index = i);
      updateCartTable();
    });
  });

  // Calcular totales
  const subtotal = cartItems.reduce((acc, curr) => acc + curr.subtotal, 0);
  updateTotalsUI(subtotal);
}

function updateTotalsUI(subtotal) {
  const total = subtotal;

  document.getElementById('summary-subtotal').textContent = formatCurrency(subtotal);
  document.getElementById('summary-total').textContent = formatCurrency(total);

  // Resetear cobro cuando cambia el carrito
  const inputCobroEfectivo = document.getElementById('cobro-efectivo');
  const inputCobroTransferencia = document.getElementById('cobro-transferencia');
  if (inputCobroEfectivo && inputCobroTransferencia) {
    cobroEfectivo = total;
    cobroTransferencia = 0;
    inputCobroEfectivo.value = total > 0 ? total : '';
    inputCobroTransferencia.value = '';
    updateCobroValidation(total);
  }

  // Validar campos del formulario
  const btnGenerateReceipt = document.getElementById('btn-generate-receipt');
  const clientName = document.getElementById('client-name')?.value.trim() || '';
  const clientAddress = document.getElementById('client-address')?.value.trim() || '';
  btnGenerateReceipt.disabled = !(clientName && clientAddress && cartItems.length > 0);
}

function updateCobroValidation(subtotal) {
  const cobroValidation = document.getElementById('cobro-validation');
  if (!cobroValidation) return;
  if (subtotal <= 0) {
    cobroValidation.textContent = '';
    cobroValidation.className = '';
    return;
  }
  const cobrado = cobroEfectivo + cobroTransferencia;
  const pendiente = Math.max(0, subtotal - cobrado);
  const vuelto = Math.max(0, cobrado - subtotal);
  if (cobrado === 0) {
    cobroValidation.textContent = 'No se ha registrado ningún cobro';
    cobroValidation.className = 'cobro-invalid';
  } else if (vuelto > 0) {
    cobroValidation.textContent = `Cobrado: ${formatCurrency(cobrado)} — A favor: ${formatCurrency(vuelto)}`;
    cobroValidation.className = 'cobro-valid';
  } else if (pendiente === 0) {
    cobroValidation.textContent = `Total cobrado: ${formatCurrency(cobrado)} — Pago completo`;
    cobroValidation.className = 'cobro-valid';
  } else {
    cobroValidation.textContent = `Cobrado: ${formatCurrency(cobrado)} — Pendiente: ${formatCurrency(pendiente)}`;
    cobroValidation.className = 'cobro-pendiente';
  }
}

// Generación y almacenamiento del comprobante (Offline-first)
async function generateComprobante() {
  const clientId = document.getElementById('client-id').value.trim();
  const clientName = document.getElementById('client-name').value.trim();
  const clientAddress = document.getElementById('client-address').value.trim();
  const clientPhone = document.getElementById('client-phone').value.trim();
  const clientEmail = document.getElementById('client-email').value.trim();
  const notes = document.getElementById('receipt-notes').value.trim();

  const subtotal = cartItems.reduce((acc, curr) => acc + curr.subtotal, 0);
  const total = subtotal;

  // Generar ID único local
  const uuid = 'comp_' + Math.random().toString(36).substr(2, 9) + Date.now().toString().substr(-4);

  const comprobante = {
    comprobante_id: uuid,
    tecnico_uid: currentUser ? currentUser.uid : 'mock_tecnico',
    tecnico_nombre: currentTechData.nombre,
    tecnico_empresa: currentTechData.empresa,
    fecha_creacion: new Date().toISOString(),
    fecha_servicio: new Date().toISOString().split('T')[0],
    cliente: {
      numero_cliente: clientId || '',
      nombre: clientName,
      direccion: clientAddress,
      telefono: clientPhone || '',
      email: clientEmail || ''
    },
    items: [...cartItems],
    subtotal: subtotal,
    total: total,
    observaciones: notes,
    metodo_cobro: {
      efectivo: cobroEfectivo,
      transferencia: cobroTransferencia,
      pendiente: Math.max(0, total - cobroEfectivo - cobroTransferencia),
      vuelto: Math.max(0, cobroEfectivo + cobroTransferencia - total)
    },
    // Online → sincronizado (se envía a Firestore abajo). Offline → pendiente, sync lo enviará al reconectar
    estado: navigator.onLine ? 'sincronizado' : 'pendiente_sincronizacion',
    fecha_sincronizacion: navigator.onLine ? new Date().toISOString() : null,
    intentos_sincronizacion: 0,
    metadata: {
      dispositivo: navigator.userAgent,
      plataforma: getPlatform(),
      version_app: '1.0.0'
    }
  };

  // Guardar comprobante en local SIEMPRE primero (para visualización inmediata)
  localStorage.setItem(`receipt_cache_${uuid}`, JSON.stringify(comprobante));

  // Guardar en la base de datos
  if (isMockMode) {
    // Modo Mock: Guardar en localStorage
    const savedReceipts = JSON.parse(localStorage.getItem('mock_comprobantes') || '[]');
    savedReceipts.push(comprobante);
    localStorage.setItem('mock_comprobantes', JSON.stringify(savedReceipts));
    console.log('Comprobante mock guardado localmente:', comprobante);
  } else if (navigator.onLine) {
    // Firebase real + online: enviar a Firestore (estado ya es 'sincronizado')
    setDoc(doc(db, 'comprobantes', uuid), comprobante)
      .then(() => console.log('Comprobante enviado a Firestore:', uuid))
      .catch(e => {
        console.error('Error al guardar comprobante en Firestore:', e);
        // Revertir estado a pendiente para que sync lo reintente
        comprobante.estado = 'pendiente_sincronizacion';
        comprobante.fecha_sincronizacion = null;
        localStorage.setItem(`receipt_cache_${uuid}`, JSON.stringify(comprobante));
      });
  }
  // Si offline: queda como pendiente_sincronizacion, sync lo enviará al reconectar

  // Limpiar Carrito y Formulario del Panel
  resetPanelForm();

  // Redirigir a la vista de comprobante
  window.location.hash = `#/comprobante/${uuid}`;
}

function resetPanelForm() {
  cartItems = [];
  document.getElementById('client-id').value = '';
  document.getElementById('client-name').value = '';
  document.getElementById('client-address').value = '';
  document.getElementById('client-phone').value = '';
  document.getElementById('client-email').value = '';
  document.getElementById('receipt-notes').value = '';
  cobroEfectivo = 0;
  cobroTransferencia = 0;
  const inputCobroEfectivo = document.getElementById('cobro-efectivo');
  const inputCobroTransferencia = document.getElementById('cobro-transferencia');
  if (inputCobroEfectivo) inputCobroEfectivo.value = '';
  if (inputCobroTransferencia) inputCobroTransferencia.value = '';
  const cobroValidation = document.getElementById('cobro-validation');
  if (cobroValidation) { cobroValidation.textContent = ''; cobroValidation.className = ''; }
  updateCartTable();
}

// Carga visual del comprobante generado (A4 o Público)
async function loadComprobanteView(id) {
  let comprobante = null;

  if (isMockMode) {
    // Mock mode: buscar en localStorage mock
    const savedReceipts = JSON.parse(localStorage.getItem('mock_comprobantes') || '[]');
    comprobante = savedReceipts.find(r => r.comprobante_id === id);
  } else {
    // Firebase real: intentar Firestore SOLO si hay conexión
    if (navigator.onLine) {
      try {
        const docRef = await getDoc(doc(db, 'comprobantes', id));
        if (docRef.exists()) {
          comprobante = docRef.data();
          // Actualizar cache local con el estado actual de Firestore
          localStorage.setItem(`receipt_cache_${id}`, JSON.stringify(comprobante));
        }
      } catch (e) {
        console.warn('Firestore no disponible, usando cache local:', e);
      }
    }

    // Si Firestore no devolvió nada o estamos offline, caer al cache local
    if (!comprobante) {
      const cached = localStorage.getItem(`receipt_cache_${id}`);
      if (cached) {
        comprobante = JSON.parse(cached);
      }
    }
  }

  const receiptPaper = document.getElementById('receipt-paper');
  const actionBar = document.querySelector('.action-bar-container');

  if (!comprobante) {
    // Mostrar error si no existe
    receiptPaper.innerHTML = `
      <div class="text-center" style="padding: 4rem;">
        <h2 style="color: var(--accent-danger);">Comprobante No Encontrado</h2>
        <p style="margin-top: 1rem; color: #4b5563;">El código de comprobante es inválido o el documento aún no se ha sincronizado con la nube.</p>
        <button onclick="window.location.hash='#/panel'" class="btn btn-secondary mt-3">Volver al Panel</button>
      </div>
    `;
    actionBar.classList.add('hidden');
    return;
  }

  // Mostrar siempre la barra de acciones (imprimir / volver) al ver un comprobante
  actionBar.classList.remove('hidden');

  // Rellenar datos en la factura A4
  document.getElementById('r-id').textContent = comprobante.comprobante_id.toUpperCase();
  document.getElementById('r-date').textContent = formatDate(comprobante.fecha_creacion);
  
  // Badge de Sync
  const syncBadge = document.getElementById('r-sync-status');
  if (comprobante.estado === 'sincronizado') {
    syncBadge.textContent = 'Sincronizado con la Nube';
    syncBadge.className = 'receipt-sync-badge sync-status-online';
  } else {
    syncBadge.textContent = 'Pendiente de Sincronización';
    syncBadge.className = 'receipt-sync-badge sync-status-offline';
  }

  // Badge de Cobro
  const cobroBadge = document.getElementById('r-cobro-badge');
  if (cobroBadge) {
    if (comprobante.metodo_cobro) {
      const ef = comprobante.metodo_cobro.efectivo || 0;
      const tr = comprobante.metodo_cobro.transferencia || 0;
      const pend = comprobante.metodo_cobro.pendiente != null ? comprobante.metodo_cobro.pendiente : Math.max(0, (comprobante.total || 0) - ef - tr);
      const vuelto = comprobante.metodo_cobro.vuelto || 0;
      const parts = [];
      if (ef > 0) parts.push(`Efectivo ${formatCurrency(ef)}`);
      if (tr > 0) parts.push(`Transferencia ${formatCurrency(tr)}`);
      if (vuelto > 0) parts.push(`A favor ${formatCurrency(vuelto)}`);
      if (pend > 0) parts.push(`Pendiente ${formatCurrency(pend)}`);
      if (parts.length > 0) {
        cobroBadge.textContent = `Cobro: ${parts.join(' / ')}`;
        cobroBadge.className = pend > 0 ? 'receipt-cobro-badge cobro-pendiente' : 'receipt-cobro-badge cobro-efectivo';
      } else {
        cobroBadge.textContent = 'Cobro: No registrado';
        cobroBadge.className = 'receipt-cobro-badge cobro-none';
      }
    } else {
      cobroBadge.textContent = 'Método de Cobro: No registrado';
      cobroBadge.className = 'receipt-cobro-badge cobro-none';
    }
  }

  // Emisor
  document.getElementById('r-tech-name').textContent = escapeHtml(comprobante.tecnico_nombre);
  document.getElementById('r-tech-company').textContent = escapeHtml(comprobante.tecnico_empresa);

  // Cliente
  const clientIdContainer = document.getElementById('r-client-id-container');
  if (comprobante.cliente.numero_cliente) {
    document.getElementById('r-client-id').textContent = escapeHtml(comprobante.cliente.numero_cliente);
    clientIdContainer.style.display = 'block';
  } else {
    clientIdContainer.style.display = 'none';
  }

  document.getElementById('r-client-name').textContent = escapeHtml(comprobante.cliente.nombre);
  document.getElementById('r-client-address').textContent = escapeHtml(comprobante.cliente.direccion);
  
  const phoneContainer = document.getElementById('r-client-phone-container');
  if (comprobante.cliente.telefono) {
    document.getElementById('r-client-phone').textContent = escapeHtml(comprobante.cliente.telefono);
    phoneContainer.style.display = 'block';
  } else {
    phoneContainer.style.display = 'none';
  }

  const emailContainer = document.getElementById('r-client-email-container');
  if (comprobante.cliente.email) {
    document.getElementById('r-client-email').textContent = escapeHtml(comprobante.cliente.email);
    emailContainer.style.display = 'block';
  } else {
    emailContainer.style.display = 'none';
  }

  // Notas
  const rNotes = document.getElementById('r-notes');
  if (comprobante.observaciones) {
    rNotes.textContent = comprobante.observaciones;
    rNotes.style.display = 'block';
  } else {
    rNotes.textContent = 'Sin observaciones adicionales.';
  }

  // Rellenar Tabla de Ítems
  const rItemsBody = document.getElementById('r-items-body');
  rItemsBody.innerHTML = '';
  comprobante.items.forEach(item => {
    const tr = document.createElement('tr');
    
    // Info de método de pago
    let paymentInfo = '';
    if (item.metodo_pago === 'cuotas' && item.cuotas_info) {
      const c = item.cuotas_info;
      const totalCuotas = c.cantidad * c.monto;
      const pendiente = totalCuotas - c.monto;
      paymentInfo = `<br><small style="color: #d97706; font-weight: 500;">1/${c.cantidad} cuotas de ${formatCurrency(c.monto)} — Pendiente: ${formatCurrency(pendiente)}</small>`;
    }

    tr.innerHTML = `
      <td>${escapeHtml(item.codigo)}</td>
      <td><strong>${escapeHtml(item.nombre)}</strong>${paymentInfo}</td>
      <td class="text-center">${item.cantidad}</td>
      <td class="text-right">${formatCurrency(item.precio_unitario)}</td>
      <td class="text-right">${formatCurrency(item.subtotal)}</td>
    `;
    rItemsBody.appendChild(tr);
  });

  // Totales
  document.getElementById('r-subtotal').textContent = formatCurrency(comprobante.subtotal);
  document.getElementById('r-total').textContent = formatCurrency(comprobante.total);

  // Generar QR Code
  // URL del QR apunta a la ruta pública del comprobante en la PWA
  const urlPublica = `${window.location.origin}${window.location.pathname}#/comprobante/${comprobante.comprobante_id}`;
  generateQRCode(urlPublica);
}

// Función Generadora de Código QR usando qrcode-generator
function generateQRCode(url) {
  const qrContainer = document.getElementById('qrcode-canvas');
  qrContainer.innerHTML = ''; // Limpiar previo

  try {
    // typeNumber 0 = auto-detect del tamaño necesario
    const typeNumber = 0;
    const errorCorrectionLevel = 'L';
    const qr = qrcode(typeNumber, errorCorrectionLevel);
    qr.addData(url);
    qr.make();
    
    // Crear el SVG o Imagen
    const cellSize = 3; // Tamaño del píxel en el QR
    const margin = 4;
    const qrImageHtml = qr.createImgTag(cellSize, margin);
    
    qrContainer.innerHTML = qrImageHtml;
  } catch (error) {
    console.error('Error al generar código QR:', error);
    qrContainer.innerHTML = '<span style="font-size: 10px; color: var(--accent-danger)">Error QR</span>';
  }
}

// Sincronización manual en background para registros guardados en Mock Mode u offline
async function syncOfflineComprobantes() {
  if (isMockMode) {
    // Sincronizar comprobantes mock pendientes si detectamos red y hay datos reales
    const savedReceipts = JSON.parse(localStorage.getItem('mock_comprobantes') || '[]');
    const pending = savedReceipts.filter(r => r.estado === 'pendiente_sincronizacion');
    
    if (pending.length === 0) return;

    console.log(`[Sync] Sincronizando ${pending.length} comprobantes locales MOCK...`);
    
    pending.forEach(r => {
      r.estado = 'sincronizado';
      r.fecha_sincronizacion = new Date().toISOString();
      
      // Actualizar cache local
      localStorage.setItem(`receipt_cache_${r.comprobante_id}`, JSON.stringify(r));
    });

    localStorage.setItem('mock_comprobantes', JSON.stringify(savedReceipts));
    console.log('[Sync] Sincronización MOCK completada.');
    
    // Si estamos en la vista de comprobante actual, actualizar UI
    const hash = window.location.hash;
    if (hash.startsWith('#/comprobante/')) {
      const parts = hash.split('/');
      const id = parts[parts.length - 1];
      loadComprobanteView(id);
    }
  } else {
    // Firebase real: enviar comprobantes pendientes locales a Firestore y actualizar caches
    console.log('[Sync] Firebase real: sincronizando comprobantes pendientes...');
    try {
      // 1. Buscar comprobantes pendientes en localStorage y enviarlos a Firestore
      const keys = Object.keys(localStorage);
      const pendingKeys = keys.filter(k => k.startsWith('receipt_cache_'));
      let syncedCount = 0;
      let failedCount = 0;
      const syncedIds = [];

      for (const key of pendingKeys) {
        try {
          const data = JSON.parse(localStorage.getItem(key));
          if (data && data.estado === 'pendiente_sincronizacion') {
            // Marcar como sincronizado ANTES de enviar — para que Firestore reciba el estado correcto
            data.estado = 'sincronizado';
            data.fecha_sincronizacion = new Date().toISOString();
            await setDoc(doc(db, 'comprobantes', data.comprobante_id), data);
            localStorage.setItem(key, JSON.stringify(data));
            syncedIds.push(data.comprobante_id);
            syncedCount++;
          }
        } catch (err) {
          failedCount++;
          console.error(`[Sync] Error enviando comprobante ${key}:`, err);
          // NO marcamos como sincronizado — queda pendiente para el próximo intento
        }
      }

      if (syncedCount > 0) {
        console.log(`[Sync] ${syncedCount} comprobantes enviados a Firestore.`);
      }
      if (failedCount > 0) {
        console.warn(`[Sync] ${failedCount} comprobantes fallaron — quedarán pendientes para el próximo intento.`);
      }
      if (syncedCount === 0 && failedCount === 0) {
        console.log('[Sync] No hay comprobantes pendientes para sincronizar.');
      }

      console.log('[Sync] Sincronización completada.');

      // 2. Si estamos en la vista de comprobante actual, recargar para reflejar estado
      const hash = window.location.hash;
      if (hash.startsWith('#/comprobante/')) {
        const parts = hash.split('/');
        const id = parts[parts.length - 1];
        loadComprobanteView(id);
      }
    } catch (e) {
      console.error('[Sync] Error en sincronización:', e);
    }
  }
}

// Alternar entre las pestañas "Nuevo Servicio" e "Historial"
function switchTab(tabName) {
  const tabBtnService = document.getElementById('tab-btn-service');
  const tabBtnHistory = document.getElementById('tab-btn-history');
  const containerService = document.getElementById('panel-service-container');
  const containerHistory = document.getElementById('panel-history-container');

  if (!tabBtnService || !tabBtnHistory || !containerService || !containerHistory) return;

  if (tabName === 'service') {
    tabBtnService.classList.add('active');
    tabBtnHistory.classList.remove('active');
    containerService.classList.remove('hidden');
    containerHistory.classList.add('hidden');
  } else if (tabName === 'history') {
    tabBtnHistory.classList.add('active');
    tabBtnService.classList.remove('active');
    containerHistory.classList.remove('hidden');
    containerService.classList.add('hidden');
    
    // Cargar historial al abrir la pestaña
    loadHistorialComprobantes();
  }
}

// Cargar y renderizar el historial de comprobantes
async function loadHistorialComprobantes() {
  const historyBody = document.getElementById('history-body');
  if (!historyBody) return;

  historyBody.innerHTML = `
    <tr>
      <td colspan="7" class="text-center">
        <div style="display: flex; justify-content: center; align-items: center; padding: 1.5rem; gap: 0.5rem; color: var(--text-secondary)">
          Cargando comprobantes... <div class="spinner" style="border-width: 2px; width: 16px; height: 16px;"></div>
        </div>
      </td>
    </tr>
  `;

  let comprobantes = [];

  if (isMockMode) {
    // Modo Demo: Cargar de localStorage
    const saved = localStorage.getItem('mock_comprobantes');
    if (saved) {
      comprobantes = JSON.parse(saved);
    }
  } else {
    // Firebase Real: Consultar Firestore
    try {
      if (!currentUser) return;
      
      // Consultamos Firestore
      const q = query(collection(db, 'comprobantes'), where('tecnico_uid', '==', currentUser.uid));
      const querySnapshot = await getDocs(q);
      
      querySnapshot.forEach((doc) => {
        comprobantes.push(doc.data());
      });
    } catch (e) {
      console.error('Error al cargar historial desde Firestore:', e);
      
      // Fallback a los cacheados localmente en localStorage
      console.log('Intentando cargar desde la caché local...');
      const keys = Object.keys(localStorage);
      keys.forEach(key => {
        if (key.startsWith('receipt_cache_')) {
          try {
            comprobantes.push(JSON.parse(localStorage.getItem(key)));
          } catch(err) {}
        }
      });
    }
  }

  // Ordenar por fecha descendente
  comprobantes.sort((a, b) => new Date(b.fecha_creacion) - new Date(a.fecha_creacion));

  // Renderizar
  historyBody.innerHTML = '';

  if (comprobantes.length === 0) {
    historyBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7" class="text-center">No se han emitido comprobantes en este dispositivo aún.</td>
      </tr>
    `;
    return;
  }

  comprobantes.forEach(c => {
    const tr = document.createElement('tr');
    
    // Configurar badges de sincronización
    let badgeHtml = '';
    if (c.estado === 'sincronizado') {
      badgeHtml = `<span class="badge-sync badge-sync-online"><span class="badge-dot"></span>Sincronizado</span>`;
    } else {
      badgeHtml = `<span class="badge-sync badge-sync-offline"><span class="badge-dot"></span>Pendiente</span>`;
    }

    // Badge de cobro
    let cobroHtml = '<span class="badge-cobro badge-cobro-none">No registrado</span>';
    if (c.metodo_cobro) {
      const ef = c.metodo_cobro.efectivo || 0;
      const trans = c.metodo_cobro.transferencia || 0;
      const pend = c.metodo_cobro.pendiente != null ? c.metodo_cobro.pendiente : Math.max(0, (c.total || 0) - ef - trans);
      const vuelto = c.metodo_cobro.vuelto || 0;
      if (pend > 0) {
        cobroHtml = `<span class="badge-cobro badge-cobro-pendiente">${formatCurrency(ef + trans)} cobr. / ${formatCurrency(pend)} pda.</span>`;
      } else if (vuelto > 0) {
        cobroHtml = `<span class="badge-cobro badge-cobro-efectivo">${formatCurrency(ef + trans)} / ${formatCurrency(vuelto)} a fav.</span>`;
      } else if (ef > 0 && trans > 0) {
        cobroHtml = `<span class="badge-cobro badge-cobro-mixed">${formatCurrency(ef)} / ${formatCurrency(trans)}</span>`;
      } else if (trans > 0) {
        cobroHtml = `<span class="badge-cobro badge-cobro-transferencia">Transferencia</span>`;
      } else {
        cobroHtml = `<span class="badge-cobro badge-cobro-efectivo">Efectivo</span>`;
      }
    }

    tr.innerHTML = `
      <td data-label="Comprobante"><strong>${escapeHtml(c.comprobante_id.toUpperCase())}</strong></td>
      <td data-label="Cliente">${escapeHtml(c.cliente.nombre)}<br><small style="color: var(--text-secondary)">${escapeHtml(c.cliente.direccion)}</small></td>
      <td data-label="Fecha">${formatDate(c.fecha_creacion)}</td>
      <td data-label="Total" class="text-right" style="font-weight: 600; color: var(--accent-secondary)">${formatCurrency(c.total)}</td>
      <td data-label="Cobro" class="text-center">${cobroHtml}</td>
      <td data-label="Sync" class="text-center">${badgeHtml}</td>
      <td data-label="Acciones" class="text-center">
        <div class="history-actions">
          <a href="#/comprobante/${escapeHtml(c.comprobante_id)}" class="btn-view-receipt">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            Ver
          </a>
        </div>
      </td>
    `;
    
    historyBody.appendChild(tr);
  });

}

// --- UTILIDADES ---

function escapeHtml(str) {
  if (!str) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(str).replace(/[&<>"']/g, c => map[c]);
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS'
  }).format(amount);
}

function formatDate(isoString) {
  if (!isoString) return '--/--/----';
  const date = new Date(isoString);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function getPlatform() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  if (/android/i.test(userAgent)) return 'android';
  if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) return 'ios';
  return 'web';
}

// --- INSTALACIÓN PWA ---

let deferredInstallPrompt = null;

function initPWAInstallPrompt() {
  // No mostrar si ya fue instalada
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) {
    return;
  }

  // No mostrar si el usuario ya la dismissó recientemente (7 días)
  const dismissedAt = localStorage.getItem('pwa_install_dismissed');
  if (dismissedAt) {
    const daysSince = (Date.now() - parseInt(dismissedAt)) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) return;
  }

  // Escuchar el evento beforeinstallprompt (Chrome, Edge, Android)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    setTimeout(() => showInstallModal(), 2500);
  });

  // Para iOS (Safari no dispara beforeinstallprompt), detectar y mostrar instrucciones
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

  if (isIOS && isSafari) {
    setTimeout(() => showInstallModal('ios'), 2500);
  }

  // Si el navegador soporta PWA pero no lanzó el evento en 5s, mostrar instrucciones genéricas
  setTimeout(() => {
    if (!deferredInstallPrompt && !isIOS) {
      showInstallModal('generic');
    }
  }, 5000);
}

function showInstallModal(platform) {
  // No volver a mostrar si ya está visible
  if (!document.getElementById('modal-install').classList.contains('hidden')) return;

  const stepsContainer = document.getElementById('install-steps');
  const btnAccept = document.getElementById('btn-install-accept');

  if (platform === 'ios') {
    stepsContainer.innerHTML = `
      <div class="step"><span class="step-num">1</span><span>Tocá el botón <strong>Compartir</strong> ↑ en Safari</span></div>
      <div class="step"><span class="step-num">2</span><span>Seleccioná <strong>"Agregar a pantalla de inicio"</strong></span></div>
      <div class="step"><span class="step-num">3</span><span>Tocá <strong>"Agregar"</strong> para confirmar</span></div>
    `;
    // En iOS no podemos instalar programáticamente, ocultamos el botón de install
    btnAccept.style.display = 'none';
  } else if (platform === 'generic') {
    stepsContainer.innerHTML = `
      <div class="step"><span class="step-num">1</span><span>En el menú del navegador, buscá <strong>"Instalar app"</strong> o <strong>"Agregar a pantalla de inicio"</strong></span></div>
      <div class="step"><span class="step-num">2</span><span>Confirmá la instalación</span></div>
      <div class="step"><span class="step-num">3</span><span>¡Listo! Accedé desde tu pantalla de inicio</span></div>
    `;
    btnAccept.style.display = 'none';
  } else {
    stepsContainer.innerHTML = `
      <div class="step"><span class="step-num">1</span><span>Tocá <strong>"Instalar App"</strong> más abajo</span></div>
      <div class="step"><span class="step-num">2</span><span>Confirmá la instalación en el diálogo del navegador</span></div>
      <div class="step"><span class="step-num">3</span><span>¡Listo! Accedé desde tu pantalla de inicio</span></div>
    `;
    btnAccept.style.display = '';
  }

  document.getElementById('modal-install').classList.remove('hidden');
}

function setupInstallModalEvents() {
  const btnAccept = document.getElementById('btn-install-accept');
  const btnDismiss = document.getElementById('btn-install-dismiss');
  const modal = document.getElementById('modal-install');

  if (btnAccept) {
    btnAccept.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        console.log('[PWA] User install choice:', outcome);
        deferredInstallPrompt = null;
      }
      modal.classList.add('hidden');
    });
  }

  if (btnDismiss) {
    btnDismiss.addEventListener('click', () => {
      localStorage.setItem('pwa_install_dismissed', Date.now().toString());
      modal.classList.add('hidden');
    });
  }
}

// ==========================================================================
// FUNCIONES DEL PANEL DE ADMINISTRADOR
// ==========================================================================

// --- CLIENTES: UTILIDADES ---
function debounce(fn, delay = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// --- PAGINACIÓN Y BÚSQUEDA: ESTADO Y UTILIDADES ---
const adminState = {
  techs:   { page: 1, search: '', perPage: 10, fullData: [], filteredData: [] },
  comps:   { page: 1, search: '', perPage: 10, fullData: [], filteredData: [] },
  caja:    { page: 1, search: '', perPage: 10, fullData: [], filteredData: [] },
  clients: { page: 1, search: '', perPage: 10, fullData: [], filteredData: [] },
};

function filterByText(array, text, fields) {
  if (!text || !text.trim()) return array;
  const terms = text.toLowerCase().trim().split(/\s+/);
  return array.filter(item => {
    return terms.every(term => {
      return fields.some(f => {
        const val = item[f];
        return val && String(val).toLowerCase().includes(term);
      });
    });
  });
}

function paginateData(array, page, perPage) {
  const totalItems = array.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * perPage;
  const data = array.slice(start, start + perPage);
  return { data, totalPages, currentPage: safePage, totalItems };
}

function renderPaginationControls(containerId, state, onPageChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (state.totalPages <= 1) return;

  const { currentPage, totalPages } = state;

  const makeBtn = (text, page, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.className = 'pagination-btn';
    if (active) btn.classList.add('active');
    if (disabled) btn.disabled = true;
    btn.textContent = text;
    btn.addEventListener('click', () => { if (!disabled && !active) onPageChange(page); });
    return btn;
  };

  const addEllipsis = () => {
    const span = document.createElement('span');
    span.className = 'pagination-ellipsis';
    span.textContent = '...';
    container.appendChild(span);
  };

  // Previous button
  container.appendChild(makeBtn('‹', currentPage - 1, currentPage === 1));

  // Page numbers with smart ellipsis
  const pages = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (currentPage > 3) addEllipsis();
    const rangeStart = Math.max(2, currentPage - 1);
    const rangeEnd = Math.min(totalPages - 1, currentPage + 1);
    for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
    if (currentPage < totalPages - 2) addEllipsis();
    pages.push(totalPages);
  }

  // Remove duplicates from pages array
  const seen = new Set();
  pages.forEach(p => {
    if (!seen.has(p)) {
      seen.add(p);
      container.appendChild(makeBtn(String(p), p, false, p === currentPage));
    }
  });

  // Next button
  container.appendChild(makeBtn('›', currentPage + 1, currentPage === totalPages));
}

// Parsea CSV → objeto JSON claveado por código con campos abreviados
// Entrada: CSV con columnas Código,Nombre,Domicilio,Teléfonos,Emails
// Salida: { "010460": { n: "nombre", d: "domicilio", t: "telefonos", e: "emails" }, ... }
function parseClientCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return {};
  const clients = {};
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].trim();
    if (!row) continue;
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (inQuotes) {
        if (ch === '"' && row[c + 1] === '"') { current += '"'; c++; }
        else if (ch === '"') { inQuotes = false; }
        else { current += ch; }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { fields.push(current.trim()); current = ''; }
        else { current += ch; }
      }
    }
    fields.push(current.trim());
    if (fields.length < 2 || !fields[0]) continue;
    const codigo = fields[0];
    const email = (fields[4] || '').replace(/,+$/, '').trim();
    clients[codigo] = {
      n: fields[1] || '',
      d: fields[2] || '',
      t: fields[3] || '',
      e: email
    };
  }
  return clients;
}

// Convierte el objeto abreviado {n,d,t,e} a formato display {nombre,domicilio,...}
function expandClient(code, c) {
  return { codigo: code, nombre: c.n || '', domicilio: c.d || '', telefonos: c.t || '', emails: c.e || '' };
}

function loadClientesFromCache() {
  if (clientesCache) return clientesCache;
  const raw = localStorage.getItem('clientes_cache');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      // Soporte: si viene como array viejo ({codigo,nombre,...}), convertir a nuevo formato
      if (Array.isArray(parsed)) {
        clientesCache = {};
        parsed.forEach(c => {
          if (c.codigo) {
            clientesCache[c.codigo] = { n: c.nombre || '', d: c.domicilio || '', t: c.telefonos || '', e: c.emails || '' };
          }
        });
        localStorage.setItem('clientes_cache', JSON.stringify(clientesCache));
      } else {
        clientesCache = parsed;
      }
    } catch { clientesCache = {}; }
  } else {
    clientesCache = {};
  }
  return clientesCache;
}

function saveClientesToCache(clientsMap) {
  clientesCache = clientsMap;
  localStorage.setItem('clientes_cache', JSON.stringify(clientsMap));
}

// Lookup instantáneo en cache local (sin Firestore)
function lookupClient(codigo) {
  if (!codigo || codigo.length < 3) return null;
  const cache = loadClientesFromCache();
  const c = cache[codigo];
  if (!c) return null;
  return expandClient(codigo, c);
}

// Precarga: 1 solo getDoc de Firestore → cache en localStorage
async function preloadClientesCache() {
  if (isMockMode || !navigator.onLine || !db) return;
  const existing = localStorage.getItem('clientes_cache');
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
      if (count > 50) return; // ya tenemos datos suficientes
    } catch { /* continue to load */ }
  }
  try {
    const docSnap = await getDoc(doc(db, 'clientes', 'directorio'));
    if (docSnap.exists()) {
      const data = docSnap.data();
      // Soporte: leer como string (nuevo) o como objeto (formato viejo)
      let clientsMap = {};
      if (data.json && typeof data.json === 'string') {
        clientsMap = JSON.parse(data.json);
      } else if (data.data && typeof data.data === 'object') {
        clientsMap = data.data;
      }
      saveClientesToCache(clientsMap);
      console.log(`[Clientes] Cache precargado: ${Object.keys(clientsMap).length} clientes desde Firestore`);
    }
  } catch (e) {
    console.warn('[Clientes] Error precargando cache:', e);
  }
}

// Upload: 1 solo setDoc — almacena como STRING para evitar el límite de index entries de Firestore
async function uploadClientsToFirestore(clientsMap) {
  const jsonString = JSON.stringify(clientsMap);
  const sizeKB = Math.round(new Blob([jsonString]).size / 1024);
  if (sizeKB > 950) {
    throw new Error(`El JSON pesa ${sizeKB} KB. Firestore tiene un límite de 1024 KB por documento. Considerá dividir el archivo.`);
  }
  // Almacenar como string plano (1 campo indexado) en vez de objeto anidado (20K+ campos)
  await setDoc(doc(db, 'clientes', 'directorio'), {
    json: jsonString,
    count: Object.keys(clientsMap).length,
    lastUpdated: new Date().toISOString()
  });
  saveClientesToCache(clientsMap);
  return { count: Object.keys(clientsMap).length, sizeKB };
}

function renderAdminClients() {
  const container = document.getElementById('admin-clients-body');
  if (!container) return;

  const cache = loadClientesFromCache();
  if (Object.keys(cache).length > 0) {
    renderClientsTable(cache);
  } else if (!isMockMode && navigator.onLine && db) {
    container.innerHTML = '<tr><td colspan="4" class="text-center" style="padding:2rem;">Cargando clientes de Firestore...</td></tr>';
    preloadClientesCache().then(() => {
      renderClientsTable(loadClientesFromCache());
    }).catch(e => {
      console.warn('[Clientes] Error cargando de Firestore:', e);
      renderClientsTable(loadClientesFromCache());
    });
  } else {
    renderClientsTable(cache);
  }
}

function renderClientsTable(cache) {
  const container = document.getElementById('admin-clients-body');
  if (!container) return;
  const state = adminState.clients;

  const codes = Object.keys(cache).sort();

  // Guardar data completa en adminState
  state.fullData = codes.map(codigo => {
    const c = cache[codigo];
    return {
      codigo,
      nombre: c.n || c.nombre || '',
      domicilio: c.d || c.domicilio || '',
      contacto: c.e || c.emails || c.t || c.telefonos || '',
      _searchText: `${codigo} ${c.n || c.nombre || ''} ${c.d || c.domicilio || ''} ${c.e || c.emails || ''} ${c.t || c.telefonos || ''}`
    };
  });

  // Actualizar total count
  const totalCountEl = document.getElementById('admin-clients-total-count');
  if (totalCountEl) totalCountEl.textContent = `${codes.length} total`;

  if (codes.length === 0) {
    container.innerHTML = '<tr class="empty-row"><td colspan="4" class="text-center">No hay clientes cargados. Subí un CSV desde el panel.</td></tr>';
    const countEl = document.getElementById('admin-clients-count');
    if (countEl) countEl.textContent = '';
    renderPaginationControls('admin-clients-pagination', { currentPage: 1, totalPages: 0, totalItems: 0 }, () => {});
    return;
  }

  // Aplicar búsqueda
  state.filteredData = filterByText(state.fullData, state.search, ['codigo', 'nombre', 'domicilio', 'contacto']);
  const paginated = paginateData(state.filteredData, state.page, state.perPage);

  // Actualizar count
  const countEl = document.getElementById('admin-clients-count');
  if (countEl) {
    countEl.textContent = state.search
      ? `${paginated.totalItems} de ${codes.length} clientes`
      : `${codes.length} clientes`;
  }

  container.innerHTML = '';
  if (paginated.data.length === 0) {
    container.innerHTML = `<tr class="empty-row"><td colspan="4" class="text-center">${state.search ? 'No se encontraron clientes con esa búsqueda.' : 'No hay clientes cargados. Subí un CSV desde el panel.'}</td></tr>`;
  } else {
    paginated.data.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Código"><strong>${escapeHtml(c.codigo)}</strong></td>
        <td data-label="Nombre">${escapeHtml(c.nombre)}</td>
        <td data-label="Domicilio">${escapeHtml(c.domicilio)}</td>
        <td data-label="Contacto">${escapeHtml(c.contacto || '--')}</td>
      `;
      container.appendChild(tr);
    });
  }

  // Paginación
  renderPaginationControls('admin-clients-pagination', paginated, (newPage) => {
    state.page = newPage;
    renderClientsTable(cache);
  });
}

// --- MODAL: CREAR / EDITAR TÉCNICO ---
function openTechModal(techData = null) {
  const modal = document.getElementById('modal-tech');
  const title = document.getElementById('modal-tech-title');
  const form = document.getElementById('form-tech');
  const errorEl = document.getElementById('modal-tech-error');
  const successEl = document.getElementById('modal-tech-success');
  const passwordGroup = document.getElementById('tech-password-group');

  form.reset();
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  if (techData) {
    // Modo edición
    title.textContent = 'Editar Técnico';
    document.getElementById('tech-edit-uid').value = techData.uid;
    document.getElementById('tech-name').value = techData.nombre || '';
    document.getElementById('tech-company').value = techData.empresa || 'TuRed';
    document.getElementById('tech-email').value = techData.email || '';
    document.getElementById('modal-tech-submit-text').textContent = 'Guardar Cambios';
    passwordGroup.classList.add('hidden');
    document.getElementById('tech-password').removeAttribute('required');
  } else {
    // Modo creación
    title.textContent = 'Crear Técnico';
    document.getElementById('tech-edit-uid').value = '';
    document.getElementById('modal-tech-submit-text').textContent = 'Crear Técnico';
    passwordGroup.classList.remove('hidden');
    document.getElementById('tech-password').setAttribute('required', '');
  }

  modal.classList.remove('hidden');
}

async function handleTechSubmit(e) {
  e.preventDefault();
  const editUid = document.getElementById('tech-edit-uid').value;
  const name = document.getElementById('tech-name').value.trim();
  const company = document.getElementById('tech-company').value.trim() || 'TuRed';
  const email = document.getElementById('tech-email').value.trim();
  const password = document.getElementById('tech-password').value;
  const errorEl = document.getElementById('modal-tech-error');
  const successEl = document.getElementById('modal-tech-success');
  const spinner = document.getElementById('modal-tech-spinner');
  const btnText = document.getElementById('modal-tech-submit-text');

  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  if (!name || !email) {
    errorEl.textContent = 'Nombre y email son obligatorios.';
    errorEl.classList.remove('hidden');
    return;
  }

  if (isMockMode) {
    errorEl.textContent = 'La gestión de técnicos requiere Firebase real (no modo Demo).';
    errorEl.classList.remove('hidden');
    return;
  }

  spinner.classList.remove('hidden');
  btnText.classList.add('hidden');

  try {
    if (editUid) {
      // --- EDICIÓN ---
      const userRef = doc(db, 'usuarios', editUid);
      await setDoc(userRef, { nombre: name, empresa: company, email }, { merge: true });
      successEl.textContent = 'Técnico actualizado correctamente.';
      successEl.classList.remove('hidden');
    } else {
      // --- CREACIÓN ---
      const savedAdminEmail = currentUser.email;

      // Paso 1: Crear usuario en Firebase Auth (esto lo loguea como el nuevo usuario)
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const newUid = userCredential.user.uid;

      // Paso 2: Cerrar sesión del nuevo usuario
      await signOut(auth);

      // Paso 3: Re-login del admin
      const adminPassword = prompt('Ingresá tu contraseña de admin para volver a iniciar sesión:');
      if (adminPassword) {
        try {
          await signInWithEmailAndPassword(auth, savedAdminEmail, adminPassword);
        } catch (e) {
          console.warn('No se pudo re-loguear al admin automáticamente.');
          window.location.hash = '#/login';
          return;
        }
      } else {
        window.location.hash = '#/login';
        return;
      }

      // Paso 4: Ahora como admin, crear el documento del técnico en Firestore
      await setDoc(doc(db, 'usuarios', newUid), {
        nombre: name,
        empresa: company,
        email: email,
        rol: 'tecnico',
        activo: true,
        fecha_registro: new Date().toISOString()
      });

      successEl.textContent = `Técnico "${name}" creado correctamente.`;
      successEl.classList.remove('hidden');
      loadAdminTechs();
    }

    setTimeout(() => {
      document.getElementById('modal-tech').classList.add('hidden');
    }, 1500);

  } catch (error) {
    console.error('Error en operación de técnico:', error);
    let errMsg = 'Error al procesar la operación.';
    if (error.code === 'auth/email-already-in-use') errMsg = 'Ya existe un usuario con ese correo electrónico.';
    else if (error.code === 'auth/weak-password') errMsg = 'La contraseña debe tener al menos 6 caracteres.';
    else if (error.code === 'auth/invalid-email') errMsg = 'El correo electrónico no es válido.';
    else if (error.code === 'auth/operation-not-allowed') errMsg = 'El registro por email/contraseña no está habilitado en Firebase Console.';
    else if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
      errMsg = 'La contraseña de admin es incorrecta.';
    }
    errorEl.textContent = errMsg;
    errorEl.classList.remove('hidden');
  } finally {
    spinner.classList.add('hidden');
    btnText.classList.remove('hidden');
  }
}

// --- CARGAR LISTA DE TÉCNICOS ---
async function loadAdminTechs() {
  const tbody = document.getElementById('admin-techs-body');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 2rem;">Cargando técnicos...</td></tr>`;

  try {
    const snapshot = await getDocs(collection(db, 'usuarios'));
    const techs = [];
    snapshot.forEach(docSnap => {
      techs.push({ uid: docSnap.id, ...docSnap.data() });
    });

    if (techs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center">No hay técnicos registrados.</td></tr>`;
      return;
    }

    // Cargar cantidad de comprobantes por técnico
    let compCounts = {};
    try {
      const compSnapshot = await getDocs(collection(db, 'comprobantes'));
      compSnapshot.forEach(docSnap => {
        const data = docSnap.data();
        compCounts[data.tecnico_uid] = (compCounts[data.tecnico_uid] || 0) + 1;
      });
    } catch (e) { /* ignore if offline */ }

    // Guardar datos completos en adminState y anexar compCounts + badge info
    adminState.techs.fullData = techs.map(tech => ({
      ...tech,
      _compCount: compCounts[tech.uid] || 0,
      _isCurrentUser: currentUser && tech.uid === currentUser.uid,
      _rolBadge: tech.rol === 'admin'
        ? '<span class="badge-admin">Admin</span>'
        : '<span class="badge-tech">Técnico</span>',
    }));

    renderAdminTechsPage();
  } catch (error) {
    console.error('Error cargando técnicos:', error);
    tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: var(--accent-danger)">Error al cargar técnicos. Verifique su conexión.</td></tr>`;
  }
}

function renderAdminTechsPage() {
  const tbody = document.getElementById('admin-techs-body');
  const state = adminState.techs;

  // Aplicar búsqueda
  state.filteredData = filterByText(state.fullData, state.search, ['nombre', 'email', 'empresa']);
  const paginated = paginateData(state.filteredData, state.page, state.perPage);

  // Actualizar count
  const countEl = document.getElementById('admin-techs-count');
  if (countEl) {
    countEl.textContent = state.search
      ? `${paginated.totalItems} de ${state.fullData.length} técnicos`
      : `${state.fullData.length} técnicos`;
  }

  // Renderizar filas
  tbody.innerHTML = '';
  if (paginated.data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">${state.search ? 'No se encontraron técnicos con esa búsqueda.' : 'No hay técnicos registrados.'}</td></tr>`;
  } else {
    paginated.data.forEach(tech => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Nombre"><strong>${escapeHtml(tech.nombre) || 'Sin nombre'}</strong>${tech._isCurrentUser ? ' <small style="color:var(--accent-primary)">(Tú)</small>' : ''}</td>
        <td data-label="Email">${escapeHtml(tech.email) || '--'}</td>
        <td data-label="Empresa">${escapeHtml(tech.empresa) || 'TuRed'}</td>
        <td data-label="Rol">${tech._rolBadge}</td>
        <td data-label="Comprobantes" class="text-center">${tech._compCount}</td>
        <td data-label="Acciones" class="text-center">
          <div class="history-actions">
            <button class="btn-icon-action btn-edit-tech" data-uid="${escapeHtml(tech.uid)}" data-nombre="${escapeHtml(tech.nombre || '')}" data-empresa="${escapeHtml(tech.empresa || '')}" data-email="${escapeHtml(tech.email || '')}" title="Editar">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="btn-icon-action btn-change-password" data-uid="${escapeHtml(tech.uid)}" data-email="${escapeHtml(tech.email || '')}" title="Cambiar Contraseña">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            </button>
            ${!tech._isCurrentUser && tech.rol !== 'admin' ? `
            <button class="btn-icon-action btn-delete-tech" data-uid="${escapeHtml(tech.uid)}" data-nombre="${escapeHtml(tech.nombre || '')}" title="Eliminar">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Event listeners
  tbody.querySelectorAll('.btn-edit-tech').forEach(btn => {
    btn.addEventListener('click', () => {
      openTechModal({
        uid: btn.dataset.uid,
        nombre: btn.dataset.nombre,
        empresa: btn.dataset.empresa,
        email: btn.dataset.email
      });
    });
  });

  tbody.querySelectorAll('.btn-change-password').forEach(btn => {
    btn.addEventListener('click', () => openPasswordModal(btn.dataset.uid, btn.dataset.email));
  });

  tbody.querySelectorAll('.btn-delete-tech').forEach(btn => {
    btn.addEventListener('click', () => {
      showConfirmModal(
        `Eliminar al técnico "${btn.dataset.nombre}"`,
        `Se eliminará la cuenta de ${btn.dataset.nombre} y todos sus datos. Esta acción no se puede deshacer.`,
        () => deleteTech(btn.dataset.uid, btn.dataset.nombre)
      );
    });
  });

  // Paginación
  renderPaginationControls('admin-techs-pagination', paginated, (newPage) => {
    state.page = newPage;
    renderAdminTechsPage();
  });
}

// --- ELIMINAR TÉCNICO ---
async function deleteTech(uid, nombre) {
  try {
    // Eliminar documento de Firestore
    await deleteDoc(doc(db, 'usuarios', uid));

    // Eliminar comprobantes del técnico
    const q = query(collection(db, 'comprobantes'), where('tecnico_uid', '==', uid));
    const snapshot = await getDocs(q);
    const batch = [];
    snapshot.forEach(docSnap => {
      batch.push(deleteDoc(doc(db, 'comprobantes', docSnap.id)));
    });
    await Promise.all(batch);

    console.log(`Técnico "${nombre}" eliminado junto con ${batch.length} comprobantes.`);
    loadAdminTechs();
    loadAllComprobantes();
  } catch (error) {
    console.error('Error eliminando técnico:', error);
    alert('Error al eliminar técnico: ' + error.message);
  }
}

// --- MODAL: CAMBIAR CONTRASEÑA ---
function openPasswordModal(uid, email) {
  document.getElementById('password-tech-uid').value = uid;
  document.getElementById('password-tech-email').value = email;
  document.getElementById('password-admin').value = '';
  document.getElementById('password-new').value = '';
  document.getElementById('modal-password-error').classList.add('hidden');
  document.getElementById('modal-password-success').classList.add('hidden');
  document.getElementById('modal-password').classList.remove('hidden');
}

async function handlePasswordChange(e) {
  e.preventDefault();
  const targetUid = document.getElementById('password-tech-uid').value;
  const targetEmail = document.getElementById('password-tech-email').value;
  const adminPw = document.getElementById('password-admin').value;
  const newPw = document.getElementById('password-new').value;
  const errorEl = document.getElementById('modal-password-error');
  const successEl = document.getElementById('modal-password-success');
  const spinner = document.getElementById('modal-password-spinner');

  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  if (!adminPw || !newPw) {
    errorEl.textContent = 'Ambos campos son obligatorios.';
    errorEl.classList.remove('hidden');
    return;
  }

  if (newPw.length < 6) {
    errorEl.textContent = 'La nueva contraseña debe tener al menos 6 caracteres.';
    errorEl.classList.remove('hidden');
    return;
  }

  spinner.classList.remove('hidden');

  try {
    if (targetUid !== currentUser.uid) {
      spinner.classList.add('hidden');
      errorEl.textContent = 'Por seguridad, solo podés cambiar tu propia contraseña desde la app. Para cambiar la contraseña de otro usuario, usá Firebase Console.';
      errorEl.classList.remove('hidden');
      return;
    }

    const credential = EmailAuthProvider.credential(currentUser.email, adminPw);
    await reauthenticateWithCredential(currentUser, credential);

    await firebaseUpdatePassword(currentUser, newPw);
    successEl.textContent = 'Tu contraseña fue actualizada correctamente.';
    successEl.classList.remove('hidden');
    setTimeout(() => {
      document.getElementById('modal-password').classList.add('hidden');
    }, 2000);

  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    let errMsg = 'Error al cambiar la contraseña.';
    if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
      errMsg = 'Tu contraseña actual es incorrecta.';
    }
    errorEl.textContent = errMsg;
    errorEl.classList.remove('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

// --- MODAL: CONFIRMAR ELIMINACIÓN ---
function showConfirmModal(title, message, onConfirm) {
  document.getElementById('modal-confirm-title').textContent = title;
  document.getElementById('modal-confirm-message').textContent = message;
  document.getElementById('modal-confirm').classList.remove('hidden');

  const btnAccept = document.getElementById('modal-confirm-accept');
  const newBtn = btnAccept.cloneNode(true);
  btnAccept.parentNode.replaceChild(newBtn, btnAccept);

  newBtn.addEventListener('click', () => {
    document.getElementById('modal-confirm').classList.add('hidden');
    onConfirm();
  });
}

// --- CARGAR TODOS LOS COMPROBANTES (VISTA ADMIN) ---
async function loadAllComprobantes() {
  const tbody = document.getElementById('admin-comps-body');
  const techFilter = document.getElementById('admin-filter-tech');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 2rem;">Cargando comprobantes...</td></tr>`;

  try {
    const snapshot = await getDocs(collection(db, 'comprobantes'));
    allAdminComprobantes = [];
    const techNames = {};

    // Cargar nombres de técnicos
    try {
      const techSnapshot = await getDocs(collection(db, 'usuarios'));
      techSnapshot.forEach(docSnap => {
        const data = docSnap.data();
        techNames[docSnap.id] = data.nombre || data.email || docSnap.id;
      });
    } catch (e) { /* offline fallback */ }
    allTechNames = { ...techNames };

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      allAdminComprobantes.push({
        ...data,
        _techName: techNames[data.tecnico_uid] || data.tecnico_nombre || 'Desconocido',
        cliente_nombre_search: data.cliente?.nombre || ''
      });
    });

    // Poblar filtro de técnicos
    if (techFilter) {
      const selectedVal = techFilter.value;
      const uniqueTechs = [...new Set(allAdminComprobantes.map(c => c.tecnico_uid))];
      techFilter.innerHTML = '<option value="">Todos los técnicos</option>';
      uniqueTechs.forEach(uid => {
        const name = techNames[uid] || uid;
        techFilter.innerHTML += `<option value="${escapeHtml(uid)}">${escapeHtml(name)}</option>`;
      });
      techFilter.value = selectedVal;
    }

    renderAdminComprobantes();
  } catch (error) {
    console.error('Error cargando comprobantes admin:', error);
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="color: var(--accent-danger)">Error al cargar comprobantes.</td></tr>`;
  }
}

function renderAdminComprobantes() {
  const tbody = document.getElementById('admin-comps-body');
  const techFilter = document.getElementById('admin-filter-tech');
  const statusFilter = document.getElementById('admin-filter-status');
  const state = adminState.comps;

  let filtered = [...allAdminComprobantes];

  // Aplicar filtros de dropdown
  if (techFilter && techFilter.value) {
    filtered = filtered.filter(c => c.tecnico_uid === techFilter.value);
  }
  if (statusFilter && statusFilter.value) {
    filtered = filtered.filter(c => c.estado === statusFilter.value);
  }

  // Aplicar búsqueda de texto
  filtered = filterByText(filtered, state.search, ['comprobante_id', '_techName', 'cliente_nombre_search']);

  filtered.sort((a, b) => new Date(b.fecha_creacion) - new Date(a.fecha_creacion));

  // Guardar data filtrada para paginación
  state.filteredData = filtered;
  const paginated = paginateData(filtered, state.page, state.perPage);

  // Actualizar count
  const countEl = document.getElementById('admin-comps-count');
  if (countEl) {
    countEl.textContent = state.search
      ? `${paginated.totalItems} de ${allAdminComprobantes.length} comprobantes`
      : `${filtered.length} comprobantes`;
  }

  if (paginated.data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">${state.search || (techFilter && techFilter.value) || (statusFilter && statusFilter.value) ? 'No se encontraron comprobantes con esos filtros.' : 'No hay comprobantes registrados.'}</td></tr>`;
  } else {
    tbody.innerHTML = '';
    paginated.data.forEach(c => {
      const tr = document.createElement('tr');
      const badgeHtml = c.estado === 'sincronizado'
        ? '<span class="badge-sync badge-sync-online"><span class="badge-dot"></span>Sincronizado</span>'
        : '<span class="badge-sync badge-sync-offline"><span class="badge-dot"></span>Pendiente</span>';

      tr.innerHTML = `
        <td data-label="Comprobante"><strong>${escapeHtml(c.comprobante_id.toUpperCase())}</strong></td>
        <td data-label="Técnico">${escapeHtml(c._techName)}</td>
        <td data-label="Cliente">${escapeHtml(c.cliente?.nombre) || '--'}</td>
        <td data-label="Fecha">${formatDate(c.fecha_creacion)}</td>
        <td data-label="Total" class="text-right" style="font-weight: 600; color: var(--accent-secondary)">${formatCurrency(c.total)}</td>
        <td data-label="Estado" class="text-center">${badgeHtml}</td>
        <td data-label="Acciones" class="text-center">
          <div class="history-actions">
            <a href="#/comprobante/${escapeHtml(c.comprobante_id)}" class="btn-view-receipt">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              Ver
            </a>
            <button class="btn-delete-receipt btn-admin-delete-comp" data-id="${escapeHtml(c.comprobante_id)}" title="Eliminar">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Event listeners para eliminar
  tbody.querySelectorAll('.btn-admin-delete-comp').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const compId = btn.dataset.id;
      showConfirmModal(
        'Eliminar comprobante',
        `Se eliminará permanentemente el comprobante ${compId.toUpperCase()}.`,
        async () => {
          try {
            await deleteDoc(doc(db, 'comprobantes', compId));
            localStorage.removeItem(`receipt_cache_${compId}`);
            loadAllComprobantes();
          } catch (err) {
            console.error('Error eliminando comprobante:', err);
            alert('Error al eliminar: ' + err.message);
          }
        }
      );
    });
  });

  // Paginación
  renderPaginationControls('admin-comps-pagination', paginated, (newPage) => {
    state.page = newPage;
    renderAdminComprobantes();
  });
}
