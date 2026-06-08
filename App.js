import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, Button, ScrollView } from 'react-native';
import nodejs from 'nodejs-mobile-react-native';

export default function App() {
  const [logs, setLogs] = useState([]);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    // Listen to messages from the Node.js background thread
    nodejs.channel.addListener('message', (msg) => {
      setLogs(prev => [...prev, msg].slice(-50)); // Keep last 50 logs
      if (msg.includes('Status: Berjalan')) setIsRunning(true);
      if (msg.includes('Status: Berhenti')) setIsRunning(false);
    });

    return () => {
      nodejs.channel.removeListener('message');
    };
  }, []);

  const startServer = () => {
    setLogs(prev => [...prev, 'Starting Node.js engine...']);
    // Start the Node.js project (which should boot index.js inside nodejs-project)
    nodejs.start('index.js');
    setIsRunning(true);
  };

  const stopServer = () => {
    setLogs(prev => [...prev, 'Stopping Node.js engine...']);
    // In a real app, send a message to gracefully shutdown
    nodejs.channel.post('stop');
    setIsRunning(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>JNE Robot Server</Text>
        <Text style={styles.subtitle}>Status: {isRunning ? '🟢 ONLINE' : '🔴 OFFLINE'}</Text>
      </View>
      
      <View style={styles.buttonContainer}>
        {!isRunning ? (
          <Button title="▶ START SERVER 24 JAM" color="#28a745" onPress={startServer} />
        ) : (
          <Button title="⏹ STOP SERVER" color="#dc3545" onPress={stopServer} />
        )}
      </View>

      <Text style={styles.logTitle}>Terminal Logs:</Text>
      <ScrollView style={styles.terminal}>
        {logs.map((log, index) => (
          <Text key={index} style={styles.logText}>{log}</Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#f4f6f9' },
  header: { alignItems: 'center', marginTop: 40, marginBottom: 20 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#0d6efd' },
  subtitle: { fontSize: 16, marginTop: 5, color: '#495057' },
  buttonContainer: { marginVertical: 20 },
  logTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 10 },
  terminal: { flex: 1, backgroundColor: '#212529', padding: 15, borderRadius: 8 },
  logText: { color: '#20c997', fontFamily: 'monospace', fontSize: 12, marginBottom: 5 },
});
