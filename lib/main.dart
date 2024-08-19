import 'package:flutter/material.dart';
import 'package:camera/camera.dart';
import 'package:image/image.dart' as img;

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final cameras = await availableCameras();
  final firstCamera = cameras.first;

  runApp(
    MaterialApp(
      home: CameraScreen(camera: firstCamera),
    ),
  );
}

class CameraScreen extends StatefulWidget {
  final CameraDescription camera;

  const CameraScreen({Key? key, required this.camera}) : super(key: key);

  @override
  _CameraScreenState createState() => _CameraScreenState();
}

class _CameraScreenState extends State<CameraScreen> {
  late CameraController _controller;
  late Future<void> _initializeControllerFuture;

  @override
  void initState() {
    super.initState();
    _controller = CameraController(
      widget.camera,
      ResolutionPreset.high,
    );
    _initializeControllerFuture = _controller.initialize();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _processImage(CameraImage image) {
    // Convert CameraImage to a format that can be processed
    final img.Image? convertedImage = convertCameraImage(image);
    if (convertedImage == null) {
      print("Failed to convert image");
      return;
    }

    // Apply Histogram Equalization
    img.histogramEqualize(convertedImage);

    // Extract the HSL-S channel
    final img.Image hslImage = img.copyRotate(convertedImage); // Create a copy
    img.convertColorSpace(hslImage, img.ColorSpace.hsl);
    final img.Image saturationChannel = img.extractChannel(hslImage, img.Channel.saturation);

    // Display or further process the resulting image
    print("Image processed successfully");
  }

  img.Image? convertCameraImage(CameraImage image) {
    try {
      if (image.format.group == ImageFormatGroup.yuv420) {
        return img.Image.fromBytes(
          width: image.width,
          height: image.height,
          bytes: image.planes[0].bytes,
          format: img.Format.uint8,
        );
      } else if (image.format.group == ImageFormatGroup.bgra8888) {
        return img.Image.fromBytes(
          width: image.width,
          height: image.height,
          bytes: image.planes[0].bytes,
          format: img.Format.uint8,
        );
      }
    } catch (e) {
      print("Error converting image: $e");
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Anomaly Detector')),
      body: FutureBuilder<void>(
        future: _initializeControllerFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.done) {
            return CameraPreview(_controller);
          } else {
            return Center(child: CircularProgressIndicator());
          }
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () async {
          try {
            await _initializeControllerFuture;
            final image = await _controller.takePicture();
            // Process the image using the _processImage function
            // Note: You'll need to convert XFile to CameraImage to use _processImage
          } catch (e) {
            print(e);
          }
        },
        child: Icon(Icons.camera),
      ),
    );
  }
}
