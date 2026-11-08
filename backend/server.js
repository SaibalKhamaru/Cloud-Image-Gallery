// Load settings from backend/.env when running locally.
const path = require('path');

require('dotenv').config({
    path: path.join(__dirname, '.env')
});
const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION;

// JSON middleware lets Express read JSON request bodies when an API needs them.
app.use(express.json());

// AWS SDK uses its normal credential chain. On EC2 this can use the instance's
// IAM role, so access keys do not need to be stored in this project.
const s3 = new S3Client({ region: AWS_REGION });

// Keep uploaded file bytes in memory until they are sent to S3. Limit each file
// to 5 MB so a very large upload cannot fill server memory.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const allowedTypes = {
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/png': ['.png'],
      'image/webp': ['.webp'],
    };
    const extension = require('path').extname(file.originalname).toLowerCase();
    const extensionsForType = allowedTypes[file.mimetype];

    // Check both the browser-provided MIME type and file extension.
    if (!extensionsForType || !extensionsForType.includes(extension)) {
      const error = new Error('Only JPG, JPEG, PNG, and WEBP image files are allowed.');
      error.statusCode = 400;
      return callback(error);
    }

    callback(null, true);
  },
});

// Check required settings when an S3 API route is used, and return a helpful
// message instead of making an AWS request with missing configuration.
function requireS3Settings(req, res, next) {
  if (!AWS_REGION || !BUCKET_NAME) {
    return res.status(500).json({
      error: 'S3 is not configured. Set AWS_REGION and S3_BUCKET_NAME in backend/.env.',
    });
  }
  next();
}

// Serve the static frontend from the same Express app to avoid cross-origin requests.
app.use('/gallery', express.static(path.join(__dirname, '../frontend')));

// Health check: visit http://localhost:3000 to confirm the server is running.
app.get('/', (req, res) => {
  res.send('Cloud Image Gallery Backend is Running');
});

// Upload one image. Send it as multipart/form-data in a field named "image".
app.post('/upload', requireS3Settings, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Choose an image file in the "image" field.' });
    }

    // Generate a safe unique key; the original filename is only returned to the user.
    const extension = require('path').extname(req.file.originalname).toLowerCase();
    const key = `${randomUUID()}${extension}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    res.status(201).json({
      message: 'Image uploaded successfully.',
      image: { key, originalName: req.file.originalname, contentType: req.file.mimetype },
    });
  } catch (error) {
    next(error);
  }
});

// List objects in the private bucket and provide a temporary viewing URL per image.
app.get('/images', requireS3Settings, async (req, res, next) => {
  try {
    const images = [];
    let continuationToken;

    // Continue through pages so galleries with more than 1,000 objects are included.
    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        ContinuationToken: continuationToken,
      }));

      for (const object of result.Contents || []) {
        if (!object.Key) continue;
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: BUCKET_NAME, Key: object.Key }),
          { expiresIn: 15 * 60 }, // Viewing link expires after 15 minutes.
        );
        images.push({
          key: object.Key,
          size: object.Size,
          lastModified: object.LastModified,
          url,
        });
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    res.json({ images });
  } catch (error) {
    next(error);
  }
});

// Create a temporary download URL for one image. The attachment disposition
// tells the browser to download it instead of displaying it in a tab.
app.get('/download', requireS3Settings, async (req, res, next) => {
  try {
    const key = req.query.key;
    if (typeof key !== 'string' || key.trim() === '') {
      return res.status(400).json({ error: 'Provide the image key in the "key" query parameter.' });
    }

    // Keep the stored image extension in the suggested download filename.
    const extension = path.extname(key).toLowerCase();
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    const safeExtension = allowedExtensions.includes(extension) ? extension : '';
    const filename = `image${safeExtension}`;
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 15 * 60 });

    res.json({ downloadUrl, filename });
  } catch (error) {
    next(error);
  }
});
// Delete an image by its S3 key, for example DELETE /images?key=the-image-key.jpg.
app.delete('/images/', requireS3Settings, async (req, res, next) => {
  try {
    const key = req.query.key;
    if (typeof key !== 'string' || key.trim() === '') {
      return res.status(400).json({ error: 'Provide the image key in the "key" query parameter.' });
    }

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    res.json({ message: 'Image deleted successfully.', key });
  } catch (error) {
    next(error);
  }
});

// Convert upload and AWS errors into predictable JSON responses.
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Image is too large. Maximum size is 5 MB.' });
    }
    return res.status(400).json({ error: `Upload error: ${error.message}` });
  }

  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error('Request failed:', error);
    return res.status(statusCode).json({ error: 'The request could not be completed. Check the server logs and AWS configuration.' });
  }

  res.status(statusCode).json({ error: error.message });
});

// Start the backend server.
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});



