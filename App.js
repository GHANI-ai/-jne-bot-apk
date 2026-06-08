import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, ScrollView, TouchableOpacity, SafeAreaView, StatusBar } from 'react-native';
import nodejs from 'nodejs-mobile-react-native';
import QRCode from 'react-native-qrcode-svg';

export default function App() {
  const [logs, setLogs] = useState(['[SYSTEM] Initializing JNE Bot Server...']);
  const [qrCode, setQrCode] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const scrollViewRef = useRef();

  useEffect(() => {
    nodejs.channel.addListener('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'log') {
          setLogs(prev => [...prev, parsed.data].slice(-100));
        } else if (parsed.type === 'qr') {
          setQrCode(parsed.data);
          setLogs(prev => [...prev, '[SYSTEM] QR Code received. Please scan to login.']);
        } else if (parsed.type === 'status') {
          if (parsed.data === 'connected') {
            setQrCode(null);
            setIsRunning(true);
            setLogs(prev => [...prev, '[SYSTEM] WhatsApp Connected Successfully!']);
          }
        }
      } catch (e) {
        // If not JSON, just treat as raw log
        setLogs(prev => [...prev, msg].slice(-100));
      }
    });

    return () => {
      nodejs.channel.removeListener('message');
    };
  }, []);

  const bootServer = () => {
    setLogs(prev => [...prev, '[SYSTEM] Booting Node.js Engine...']);
    nodejs.start('index.js');
    setIsRunning(true);
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>JNE BOT TERMINAL</Text>
        <View style={styles.statusBadge(isRunning)}>
          <Text style={styles.statusText}>{isRunning ? 'ONLINE' : 'OFFLINE'}</Text>
        </View>
      </View>

      {/* QR Code Container */}
      {qrCode && (
        <View style={styles.qrContainer}>
          <View style={styles.qrWrapper}>
            <QRCode value={qrCode} size={220} backgroundColor="white" />
          </View>
          <Text style={styles.qrText}>SCAN QR UNTUK LOGIN WHATSAPP</Text>
        </View>
      )}

      {/* Terminal View */}
      <View style={styles.terminalContainer}>
        <ScrollView 
          ref={scrollViewRef}
          onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: false })}
          style={styles.terminal}
        >
          {logs.map((log, index) => (
            <Text key={index} style={styles.logText}>
              <Text style={styles.logPrompt}>root@android:~# </Text>
              {log}
            </Text>
          ))}
        </ScrollView>
      </View>

      {/* Boot Button */}
      {!isRunning && (
        <TouchableOpacity style={styles.bootButton} onPress={bootServer}>
          <Text style={styles.bootButtonText}>[ EXECUTE SERVER BOOT ]</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 15, borderBottomWidth: 1, borderBottomColor: '#333' },
  headerTitle: { color: '#00ff00', fontSize: 18, fontWeight: 'bold', fontFamily: 'monospace' },
  statusBadge: (on) => ({ backgroundColor: on ? '#00ff00' : '#ff0000', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4 }),
  statusText: { color: '#000', fontWeight: 'bold', fontSize: 12 },
  qrContainer: { alignItems: 'center', padding: 20, backgroundColor: '#111', borderBottomWidth: 1, borderBottomColor: '#333' },
  qrWrapper: { padding: 10, backgroundColor: '#fff', borderRadius: 8 },
  qrText: { color: '#00ff00', marginTop: 15, fontFamily: 'monospace', fontWeight: 'bold' },
  terminalContainer: { flex: 1, padding: 10 },
  terminal: { flex: 1 },
  logText: { color: '#cccccc', fontFamily: 'monospace', fontSize: 12, marginBottom: 4 },
  logPrompt: { color: '#00ff00' },
  bootButton: { backgroundColor: '#00ff00', margin: 20, padding: 15, alignItems: 'center', borderRadius: 4 },
  bootButtonText: { color: '#000', fontWeight: 'bold', fontFamily: 'monospace', fontSize: 16 }
});
