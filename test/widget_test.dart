import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:anomaly_detector/main.dart';  // Ensure this matches your actual package

void main() {
  testWidgets('Camera Screen Widget Test', (WidgetTester tester) async {
    // Build our app and trigger a frame.
    final cameras = await availableCameras();
    await tester.pumpWidget(MaterialApp(home: CameraScreen(camera: cameras.first)));

    // Verify if CameraPreview is displayed
    expect(find.byType(CameraPreview), findsOneWidget);
  });
}
