// The page is served by the same Express app, so an empty base URL means
// requests go to the existing backend routes on this same origin.
const API_BASE_URL = '';

const form = document.querySelector('#upload-form');
const fileInput = document.querySelector('#image-input');
const chooseButton = document.querySelector('#choose-button');
const uploadButton = document.querySelector('#upload-button');
const fileLabel = document.querySelector('#file-label');
const uploadStatus = document.querySelector('#upload-status');
const galleryGrid = document.querySelector('#gallery-grid');
const emptyState = document.querySelector('#empty-state');
const loadingState = document.querySelector('#loading-state');
const imageCount = document.querySelector('#image-count');
const refreshButton = document.querySelector('#refresh-button');
const toast = document.querySelector('#toast');
let toastTimer;

chooseButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileLabel.textContent = file ? file.name : 'Drop an image here or browse';
  uploadButton.disabled = !file;
  setUploadStatus(file ? `${formatBytes(file.size)} selected` : 'Ready when you are');
});

// Make the large upload panel accept drag-and-drop as well as the file picker.
chooseButton.addEventListener('dragover', (event) => {
  event.preventDefault();
  chooseButton.classList.add('dragover');
});
chooseButton.addEventListener('dragleave', () => chooseButton.classList.remove('dragover'));
chooseButton.addEventListener('drop', (event) => {
  event.preventDefault();
  chooseButton.classList.remove('dragover');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('change'));
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  uploadButton.disabled = true;
  uploadButton.textContent = 'Uploading…';
  setUploadStatus('Sending your image securely…');

  try {
    const data = new FormData();
    data.append('image', file);
    const response = await fetch(`${API_BASE_URL}/upload`, { method: 'POST', body: data });
    const result = await readResponse(response);
    showToast(result.message || 'Image uploaded.');
    form.reset();
    fileLabel.textContent = 'Drop an image here or browse';
    setUploadStatus('Ready when you are');
    await loadImages();
  } catch (error) {
    setUploadStatus(error.message, 'error');
    showToast(error.message, true);
  } finally {
    uploadButton.innerHTML = 'Upload image <span>↗</span>';
    uploadButton.disabled = !fileInput.files[0];
  }
});

refreshButton.addEventListener('click', loadImages);

async function loadImages() {
  loadingState.hidden = false;
  galleryGrid.replaceChildren();
  emptyState.hidden = true;
  refreshButton.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/images`);
    const result = await readResponse(response);
    const images = Array.isArray(result.images) ? result.images : [];
    imageCount.textContent = images.length;
    loadingState.hidden = true;
    emptyState.hidden = images.length !== 0;
    images.forEach((image, index) => galleryGrid.append(createImageCard(image, index)));
  } catch (error) {
    loadingState.hidden = true;
    imageCount.textContent = '—';
    showToast(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
}

function createImageCard(image, index) {
  const card = document.createElement('article');
  card.className = 'image-card';
  card.style.animationDelay = `${Math.min(index * 45, 300)}ms`;

  const imageWrap = document.createElement('div');
  imageWrap.className = 'image-wrap';
  const img = document.createElement('img');
  img.src = image.url;
  img.alt = image.key || 'Gallery image';
  img.loading = 'lazy';
  imageWrap.append(img);

  const details = document.createElement('div');
  details.className = 'image-details';
  const name = document.createElement('div');
  name.className = 'image-name';
  name.textContent = image.key || 'Image';
  name.title = image.key || '';
  const date = document.createElement('div');
  date.className = 'image-date';
  date.textContent = image.lastModified ? new Date(image.lastModified).toLocaleDateString() : formatBytes(image.size || 0);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const download = document.createElement('a');
  download.className = 'card-action';
  download.href = `${API_BASE_URL}/download?key=${encodeURIComponent(image.key || '')}`;
  download.textContent = '↓ Download';
  download.addEventListener('click', (event) => {
    event.preventDefault();
    downloadImage(image.key, download);
  });
  const remove = document.createElement('button');
  remove.className = 'card-action delete';
  remove.type = 'button';
  remove.textContent = '× Delete';
  remove.addEventListener('click', () => deleteImage(image.key, remove));

  actions.append(download, remove);
  details.append(name, date, actions);
  card.append(imageWrap, details);
  return card;
}


// Ask the backend for a signed attachment URL, then start the browser download.
async function downloadImage(key, button) {
  if (!key) return showToast('This image is missing its S3 key.', true);
  button.setAttribute('aria-disabled', 'true');
  try {
    const response = await fetch(`${API_BASE_URL}/download?key=${encodeURIComponent(key)}`);
    const result = await readResponse(response);
    const link = document.createElement('a');
    link.href = result.downloadUrl;
    link.download = result.filename || 'image';
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    showToast(error.message || 'Could not download this image.', true);
  } finally {
    button.removeAttribute('aria-disabled');
  }
}
async function deleteImage(key, button) {
  if (!key) return showToast('This image is missing its S3 key.', true);
  button.disabled = true;
  try {
    const response = await fetch(`${API_BASE_URL}/images?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
    const result = await readResponse(response);
    showToast(result.message || 'Image deleted.');
    await loadImages();
  } catch (error) {
    button.disabled = false;
    showToast(error.message, true);
  }
}

async function readResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function setUploadStatus(message, state = '') {
  uploadStatus.textContent = message;
  uploadStatus.className = `status ${state}`;
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast visible${isError ? ' error' : ''}`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// Load the current S3 gallery as soon as the page opens.
loadImages();


