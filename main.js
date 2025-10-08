const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

// --- Helper Classes (unchanged) ---
class RadioInput {
  constructor(name, onChange) {
    this.inputs = document.querySelectorAll(`input[name=${name}]`);
    for (let input of this.inputs) {
      input.addEventListener('change', onChange);
    }
  }
  get value() {
    for (let input of this.inputs) {
      if (input.checked) return input.value;
    }
  }
}

class Input {
  constructor(id, onChange) {
    this.input = document.getElementById(id);
    this.input.addEventListener('change', onChange);
    this.valueAttrib = this.input.type === 'checkbox' ? 'checked' : 'value';
  }
  get value() {
    return this.input[this.valueAttrib];
  }
}

class CubeFace {
  constructor(faceName) {
    this.faceName = faceName;
    this.anchor = document.createElement('a');
    this.anchor.style.position = 'absolute';
    this.anchor.title = faceName;
    this.img = document.createElement('img');
    this.img.style.filter = 'blur(4px)';
    this.anchor.appendChild(this.img);
  }

  setPreview(url, x, y, size) {
    this.img.src = url;
    this.img.style.width = `${size}px`;
    this.img.style.height = `${size}px`;
    this.anchor.style.left = `${x}px`;
    this.anchor.style.top = `${y}px`;
  }

  setDownload(url, fileExtension) {
    this.anchor.href = url;
    this.anchor.download = `${this.faceName}.${fileExtension}`;
    this.img.style.filter = '';
  }
}

function removeChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

const mimeType = {
  jpg: 'image/jpeg',
  png: 'image/png'
};

// Modified to return both the Object URL and the Blob for zipping
function getBlobAndUrl(imgData, extension) {
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  ctx.putImageData(imgData, 0, 0);
  return new Promise(resolve => {
    canvas.toBlob(blob => {
      resolve({
        blob: blob,
        url: URL.createObjectURL(blob)
      });
    }, mimeType[extension], 0.92);
  });
}

// --- DOM and Settings ---
const dom = {
  imageInput: document.getElementById('imageInput'),
  outputContainer: document.getElementById('output-container'),
  generating: document.getElementById('generating'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  useSubfolders: document.getElementById('useSubfolders'), // Added this line
};

const settings = {
  cubeRotation: new Input('cubeRotation', handleFiles),
  interpolation: new RadioInput('interpolation', handleFiles),
  format: new RadioInput('format', handleFiles),
};

const facePositions = {
  pz: { x: 1, y: 1 }, nz: { x: 3, y: 1 },
  px: { x: 2, y: 1 }, nx: { x: 0, y: 1 },
  py: { x: 1, y: 0 }, ny: { x: 1, y: 2 }
};


// --- Main Batch Logic ---

// This will store the final data for the ZIP file
let allFacesData = [];

dom.imageInput.addEventListener('change', handleFiles);
dom.downloadAllBtn.addEventListener('click', downloadAll);

function handleFiles() {
  const files = dom.imageInput.files;
  if (!files.length) return;

  // Reset state for a new batch
  removeChildren(dom.outputContainer);
  allFacesData = [];
  dom.generating.style.visibility = 'visible';
  dom.downloadAllBtn.disabled = true;

  let filesProcessed = 0;

  for (const file of files) {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.addEventListener('load', () => {
      const { width, height } = img;
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, width, height);

      processImage(data, file.name).then(() => {
        filesProcessed++;
        // If all files are done, enable the download button
        if (filesProcessed === files.length) {
          dom.generating.style.visibility = 'hidden';
          dom.downloadAllBtn.disabled = false;
        }
      });
    });
  }
}

function processImage(data, fileName) {
  return new Promise(resolve => {
    // Create a container for this image's output
    const resultBlock = document.createElement('div');
    resultBlock.className = 'result-block';
    
    const title = document.createElement('h3');
    title.textContent = fileName;
    resultBlock.appendChild(title);

    const facesContainer = document.createElement('div');
    facesContainer.className = 'cubemap-faces';
    resultBlock.appendChild(facesContainer);
    
    dom.outputContainer.appendChild(resultBlock);

    let facesDone = 0;
    const workers = [];
    const imageFaces = { fileName: fileName.substring(0, fileName.lastIndexOf('.')), faces: [] };

    for (const [faceName, position] of Object.entries(facePositions)) {
      const worker = new Worker('convert.js');
      workers.push(worker);

      const face = new CubeFace(faceName);
      facesContainer.appendChild(face.anchor);

      const options = {
        data: data,
        face: faceName,
        rotation: Math.PI * settings.cubeRotation.value / 180,
        interpolation: settings.interpolation.value,
      };

      worker.onmessage = ({ data: imageData }) => {
        // This is the final, high-quality face
        const extension = settings.format.value;
        getBlobAndUrl(imageData, extension).then(({ blob, url }) => {
          face.setDownload(url, extension);
          
          // Store blob for zipping
          imageFaces.faces.push({ faceName, extension, blob });
          
          facesDone++;
          if (facesDone === 6) {
            allFacesData.push(imageFaces);
            workers.forEach(w => w.terminate());
            resolve(); // Resolve promise for this image
          }
        });
      };
      
      // Initially, render a fast, low-res preview
      const previewOptions = { ...options, maxWidth: 150, interpolation: 'linear' };
      const previewWorker = new Worker('convert.js');
      previewWorker.onmessage = ({ data: previewData }) => {
          const size = previewData.width;
          const x = size * position.x;
          const y = size * position.y;
          getBlobAndUrl(previewData, 'jpg').then(({url}) => face.setPreview(url, x, y, size));
          previewWorker.terminate();
          // Now start the full-quality render
          worker.postMessage(options);
      };
      previewWorker.postMessage(previewOptions);
    }
  });
}

function downloadAll() {
  const zip = new JSZip();
  const createSubfolders = dom.useSubfolders.checked;

  for (const imageData of allFacesData) {
    // If subfolders are enabled, create a folder for each image
    const target = createSubfolders ? zip.folder(imageData.fileName) : zip;

    for (const face of imageData.faces) {
      // If subfolders are disabled, rename the file to include the original image name
      const fileName = createSubfolders
        ? `${face.faceName}.${face.extension}`
        : `${imageData.fileName}_${face.faceName}.${face.extension}`;

      target.file(fileName, face.blob);
    }
  }

  zip.generateAsync({ type: 'blob' }).then(content => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `cubemaps_${Date.now()}.zip`;
    document.body.appendChild(link); // Required for Firefox
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  });
}