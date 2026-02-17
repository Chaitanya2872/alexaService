import logging
import time
import json
import uuid
import urllib3
#import requests


from uuid import getnode as get_mac
import boto3 
import datetime
#import requests
timestamp = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%f')
#clients = boto3.client('iot')
http=urllib3.PoolManager()
# For connecting MQTT connection.
#import paho.mqtt.client as mqtt
#import paho.mqtt.client as paho
#from paho import mqtt
# Imports for v3 validation

emailid=""

#Setup MQTT connection
#host = "a1r6z29mxc63px-ats.iot.ap-south-1.amazonaws.com"
#port = 8883 mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
pub_topic = "mqtt/device/IOTIQ_HUB/control"
#pub_aws_topic="$aws/rules/Mqtt_RulesAiera/Update"
#mqttc = paho.Client()
mqtta=boto3.client('iot-data', region_name='ap-south-1')

#mqttc.tls_set(tls_version=mqtt.client.ssl.PROTOCOL_TLS)
#mqttc.username_pw_set("Saravana_m", "Aiera@123")
#mqttc.connect(host, port, 60)
#mqttc.loop_start()

#mqttc.loop_forever()
# Setup logger
logger = logging.getLogger()
data = logger.setLevel(logging.INFO)


# To simplify this sample Lambda, we omit validation of access tokens and retrieval of a specific
# user's appliances. Instead, this array includes a variety of virtual appliances in v2 API syntax,
# and will be used to demonstrate transformation between v2 appliances and v3 endpoints.
SAMPLE_APPLIANCES2 = [
    {
        "applianceId": "SW05",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "two way Switch",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"
        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SAC02",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "AC Switch",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"
        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL01",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Head Board Side Light",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL02",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Curtain Side Light",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL03",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "TV Side Light",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL04",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Mirror Light",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL05",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Foot Lamp",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL06",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Cove Light",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL07",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Wash Room Light",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL08",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Emergency Light",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SW07",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Floor lamp",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SCC01",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "Main curtain",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SCC02",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "Main curtain stop",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SCC03",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "Sheer curtain",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SCC04",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "Sheer curtain stop",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SF01",
        "manufacturerName": "Aiera",
        "modelName": "Smart Fan",
        "friendlyName": "Fan",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SAC01",
        "manufacturerName": "Aiera",
        "modelName": "Smart Thermostat",
        "friendlyName": "AC",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "STV01",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "TV Switch",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "STV02",
        "manufacturerName": "Aiera",
        "modelName": "Smart TV",
        "friendlyName": "TV",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SSC01",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "Welcome",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SSC02",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "Good bye",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SSC03",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "Good night",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL09",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "socket",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SL08",
        "manufacturerName": "Aiera",
        "modelName": "Smart Light",
        "friendlyName": "Side lamp",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SSC04",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "Entry",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    },
    {
        "applianceId": "SSC05",
        "manufacturerName": "Aiera",
        "modelName": "Smart Switch",
        "friendlyName": "All Lights",
        "isReachable": True,
        "actions": [
            "turnOn",
            "turnOff"

        ],
        "additionalApplianceDetails": {}
    }
]



# global SAMPLE_APPLIANCES
def lambda_handler(request, handler_input):
    """Main Lambda handler.
    mqttc.loop_start()
    Since you can expect both v2 and v3 directives for a period of time during the migration
    and transition of your existing users, this main Lambda handler must be modified to support
    both v2 and v3 requests.
    """
    #mqtt_message =handler_input
    #mqttc.loop_forever()
    #mqttc.connect(host, port)
    #mqttc.loop_start() 
    
    ##Customer profile to get email
    
    
    try:
        logger.info("Directive:")
        logger.info(json.dumps(request, indent=4, sort_keys=True))

        version = get_directive_version(request)
        
        if version == "3":
            logger.info("Received v3 directive!")
            if request["directive"]["header"]["name"] == "Discover":
                response = handle_discovery_v3(request)
                #mqttc.publish(pub_topic, "Discovering", 1)
            else:
                response = handle_non_discovery_v3(request)
        else:
            logger.info("Received v2 directive!")
            if request["header"]["namespace"] == "Alexa.ConnectedHome.Discovery":
                response = handle_discovery()
            else:
                response = handle_non_discovery(request)

        logger.info("Response:")
        logger.info(json.dumps(response, indent=4, sort_keys=True))

        #if version == "3":
            #logger.info("Validate v3 response")
            #validate_message(request, response)
            

        return response
    except ValueError as error:
        logger.error(error)
        raise
    
    
# v2 handlers
def handle_discovery():
    header = {
        "namespace": "Alexa.ConnectedHome.Discovery",
        "name": "DiscoverAppliancesResponse",
        "payloadVersion": "2",
        "messageId": get_uuid()
    }
    payload = {
        "discoveredAppliances": SAMPLE_APPLIANCES2
        
    }
    response = {
        "header": header,
        "payload": payload
    }
    return response

def handle_non_discovery(request):
    request_name = request["header"]["name"]

    if request_name == "TurnOnRequest":
        #mqttc.publish(pub_topic, request_name, 1)
        header = {
            "namespace": "Alexa.ConnectedHome.Control",
            "name": "TurnOnConfirmation",
            "payloadVersion": "2",
            "messageId": get_uuid()
        }
        payload = {}
    elif request_name == "TurnOffRequest":
        #mqttc.publish(pub_topic, request_name, 1)
        header = {
            "namespace": "Alexa.ConnectedHome.Control",
            "name": "TurnOffConfirmation",
            "payloadVersion": "2",
            "messageId": get_uuid()
        }
    # other handlers omitted in this example
    payload = {}
    response = {
        "header": header,
        "payload": payload
    }
    return response

# v2 utility functions
def get_appliance_by_appliance_id(appliance_id):
    for appliance in SAMPLE_APPLIANCES2:
        if appliance["applianceId"] == appliance_id:
            return appliance
    return None

def get_utc_timestamp(seconds=None):
    return time.strftime("%Y-%m-%dT%H:%M:%S.00Z", time.gmtime(seconds))

def get_uuid():
    return str(uuid.uuid1())

# v3 handlers
def handle_discovery_v3(request):
    
    endpoints = []
    for appliance in SAMPLE_APPLIANCES2:
        endpoints.append(get_endpoint_from_v2_appliance(appliance))
    #for appliance in SAMPLE_APPLIANCES2:
        #endpoints.append(get_endpoint_from_v2_appliance(appliance))
    #mqttc.publish(pub_topic, str(SAMPLE_APPLIANCES), 1)
    sets=str(endpoints)
    mqtta.publish(topic='Aiera/State', qos=1, payload=sets)
    response = {
        "event": {
            "header": {
                "namespace": "Alexa.Discovery",
                "name": "Discover.Response",
                "payloadVersion": "3",
                "messageId": get_uuid()
            },
            "payload": {
                "endpoints": endpoints
            }
        }
    
    }
    #mqttc.publish(pub_topic, str(response), 1)
    return response
#def email(endpoint_id,headerid):
 #   r = requests.get(endpoint, headers=headerid)
  #  emailid = r.json()
    
def handle_non_discovery_v3(request):
    request_namespace = request["directive"]["header"]["namespace"]
    request_name = request["directive"]["header"]["name"]
    endpoint_topic = request["directive"]["endpoint"]["endpointId"]
    tokens = request["directive"]["endpoint"]["scope"]["token"]
   # Call this function whenever you need the MAC address
    endpoint="https://api.amazon.com/auth/O2/tokeninfo?access_token="
    url=endpoint+tokens
    e = http.request('GET',url)
    aws_id=""
    if e.status == 200:
        content=json.loads(e.data.decode("utf-8"))
        aws_id=content['user_id']

    if request_namespace == "Alexa.PowerController":
        #device_id = request["directive"]["context"]["System"]["device"]["deviceId"]
        if request_name == "TurnOn":
            value = "ON"
            msg = "{" 
            msg += "\"AieraId\":\""
            msg +=endpoint_topic
            msg +="\","
            msg += "\"Data_Topics\":\""
            msg +=request_name
            msg +="\","
            msg += "\"RoomId\":\""
            msg +=aws_id
            msg +="\","            
            msg +="\"StatusId\":\""
            msg +=value
            msg +="\"}"
            try:
                #mqttc.publish(pub_topic, msg, 1)
                #client.publish(topic='esp32/sub',qos=1, payload=json.dumps(msg)
                mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
            except:
                try:
                    #mqttc.publish(pub_topic, msg, 1)
                    #client.publish(topic='esp32/sub',qos=1, payload=json.dumps(msg)
                    mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                except:
                    print("DATA connection error")
        elif request_name == "TurnOff":
            value = "OFF"
            msg = "{" 
            msg += "\"AieraId\":\""
            msg +=endpoint_topic
            msg +="\","
            msg += "\"Data_Topics\":\""
            msg +=request_name
            msg +="\","
            msg += "\"RoomId\":\""
            msg +=aws_id
            msg +="\","             
            msg +="\"StatusId\":\""
            msg +=value
            msg +="\"}"
            try:
                #mqttc.publish(pub_topic, msg, 1)
                #client.publish(topic='esp32/sub',qos=1, payload=json.dumps(msg)
                mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
            except:
                try:
                    #mqttc.publish(pub_topic, msg, 1)
                    #client.publish(topic='esp32/sub',qos=1, payload=json.dumps(msg)
                    mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                except:
                    print("connection error")
            #mqttc.loop_start()
        response = {
            "context": {
                "properties": [
                    {
                        "namespace": "Alexa.PowerController",
                        "name": "powerState",
                        "value": value,
                        "timeOfSample": get_utc_timestamp(),
                        "uncertaintyInMilliseconds": 500
                    },
                    {
                        "namespace": "Alexa.EndpointHealth",
                        "name": "powerState",
                        "value": {
                            "value": "OK"
                        },
                        "timeOfSample": get_utc_timestamp(),
                        "uncertaintyInMilliseconds": 500
                    }
                ]
            },
            "event": {
                "header": {
                    "namespace": "Alexa",
                    "name": "Response",
                    "payloadVersion": "3",
                    "messageId": get_uuid(),
                    "correlationToken": request["directive"]["header"]["correlationToken"]
                },
                "endpoint": {
                    "scope": {
                        "type": "BearerToken",
                        "token": "access-token-from-Amazon"
                    },
                    "endpointId": request["directive"]["endpoint"]["endpointId"]
                },
                "payload": {
                    "value": value
                }
            }
        }
        return response
    elif request_namespace == "Alexa.PowerLevelController":
        if request_name == "SetPowerLevel":
            request_data =  request["directive"]["payload"]["powerLevel"]
            mqtta.publish(topic='Aiera/State', qos=1, payload=request_data)
            if request_data<=4:
                request_data=(request_data*25)-1
                values = str(request_data)
                msg = "{" 
                msg += "\"AieraId\":\""
                msg +=endpoint_topic
                msg +="\","
                msg += "\"Data_Topics\":\""
                msg +=request_name
                msg +="\","
                msg += "\"RoomId\":\""
                msg +=aws_id
                #msg +=str(hex(uuid.getnode()))
                msg +="\"," 
                msg +="\"StatusId\":\""
                msg +=values
                msg +="\"}"
            else :
                values = str(request_data-1)
                msg = "{" 
                msg += "\"AieraId\":\""
                msg +=endpoint_topic
                msg +="\","
                msg += "\"Data_Topics\":\""
                msg +=request_name
                msg +="\","
                msg += "\"RoomId\":\""
                msg +=aws_id
                #msg +=str(hex(uuid.getnode()))
                msg +="\","                 
                msg +="\"StatusId\":\""
                msg +=values
                msg +="\"}"
                
            try:
                #mqttc.publish(pub_topic, msg, 1)
                mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                #mqttc.publish(pub_topic, 1, msg)
            except:
                try:
                    #mqttc.publish(pub_topic, msg, 1)
                    mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                    #mqttc.publish(pub_topic, 1, msg)
                except:
                    print("DATA connection error")

        response = {
            "context": {
                "properties": [
                    {
                        "namespace": "Alexa.PowerLevelController",
                        "instance" : "Fan.Speed",
						"name": "powerLevel",
                        "value": 40,
                        "timeOfSample": get_utc_timestamp(),
                        "uncertaintyInMilliseconds": 200
                    },
					{
						"namespace": "Alexa.EndpointHealth",
						"name": "connectivity",
						"value": {
                    "value": "OK"
					},
					"timeOfSample": "2017-09-27T18:30:30.45Z",
					"uncertaintyInMilliseconds": 200
					}
                ]
            },
            "event": {
                "header": {
                    "namespace": "Alexa",
                    "name": "Response",
                    "payloadVersion": "3",
                    "messageId": get_uuid(),
                    "correlationToken": request["directive"]["header"]["correlationToken"]
                },
                "endpoint": {
                    "scope": {
                        "type": "BearerToken",
                        "token": "access-token-from-Amazon"
                    },
                    "endpointId": request["directive"]["endpoint"]["endpointId"]
                },
                "payload": {
                     "powerLevel": 40
                }
            }

        }
        return response  
    elif request_namespace == "Alexa.Speaker":
        if request_name == "SetMute":
            request_data =  request["directive"]["payload"]["mute"]
            if request_data==1:
                msg = "{" 
                msg += "\"AieraId\":\""
                msg +=endpoint_topic
                msg +="\","
                msg += "\"Data_Topics\":\""
                msg +=request_name
                msg +="\","
                msg += "\"RoomId\":\""
                msg +=aws_id
                #msg +=str(hex(uuid.getnode()))
                msg +="\"," 
                msg +="\"StatusId\":\""
                msg +=str(request_data)
                msg +="\"}"
            else :
                msg = "{" 
                msg += "\"AieraId\":\""
                msg +=endpoint_topic
                msg +="\","
                msg += "\"Data_Topics\":\""
                msg +=request_name
                msg +="\","
                msg += "\"RoomId\":\""
                msg +=aws_id
                #msg +=str(hex(uuid.getnode()))
                msg +="\"," 
                msg +="\"StatusId\":\""
                msg +=str(request_data)
                msg +="\"}"
                
            try:
                #mqttc.publish(pub_topic, msg, 1)
                mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                #mqttc.publish(pub_topic, 1, msg)
            except:
                try:
                    #mqttc.publish(pub_topic, msg, 1)
                    mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                    #mqttc.publish(pub_topic, 1, msg)
                except:
                    print("DATA connection error")
            response={
            "context": {
                "properties": [
                    {
                        "namespace": "Alexa.Speaker",
                        "name": "volume",
                        "value": 50,
                        "timeOfSample": "2017-02-03T16:20:50.52Z",
                        "uncertaintyInMilliseconds": 0
                    },
                    {
                        "namespace": "Alexa.Speaker",
                        "name": "muted",
                        "value": False,
                        "timeOfSample": "2017-02-03T16:20:50.52Z",
                        "uncertaintyInMilliseconds": 0
                    },
                    {
                        "namespace": "Alexa.PowerController",
                        "name": "powerState",
                        "value": "ON",
                        "timeOfSample": "2017-02-03T16:20:50.52Z",
                        "uncertaintyInMilliseconds": 500
                    }
                ]
            },
            "event": {
                "header": {
                    "namespace": "Alexa",
                    "name": "Response",
                    "messageId": get_uuid(),
                    "correlationToken": request["directive"]["header"]["correlationToken"],
                    "payloadVersion": "3"
                },
                "endpoint":{
                    "endpointId":  request["directive"]["endpoint"]["endpointId"]
                },
                "payload": {}
            }            
            }
            return response
        
        elif request_name == "AdjustVolume":
            request_data =  request["directive"]["payload"]["volume"]
            values = str(request_data)
            msg = "{" 
            msg += "\"AieraId\":\""
            msg +=endpoint_topic
            msg +="\","
            msg += "\"Data_Topics\":\""
            msg +=request_name
            msg +="\","
            msg += "\"RoomId\":\""
            msg +=aws_id
            #msg +=str(hex(uuid.getnode()))
            msg +="\"," 
            msg +="\"StatusId\":\""
            msg +=values
            msg +="\"}"

                
            try:
                #mqttc.publish(pub_topic, msg, 1)
                mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                #mqttc.publish(pub_topic, 1, msg)
            except:
                try:
                    #mqttc.publish(pub_topic, msg, 1)
                    mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                    #mqttc.publish(pub_topic, 1, msg)
                except:
                    print("DATA connection error")
        response={
            "context": {
                "properties": [
                    {
                        "namespace": "Alexa.Speaker",
                        "name": "volume",
                        "value": request_data,
                        "timeOfSample": "2017-02-03T16:20:50.52Z",
                        "uncertaintyInMilliseconds": 0
                    },
                    {
                        "namespace": "Alexa.Speaker",
                        "name": "muted",
                        "value": False,
                        "timeOfSample": "2017-02-03T16:20:50.52Z",
                        "uncertaintyInMilliseconds": 0
                    },
                    {
                        "namespace": "Alexa.PowerController",
                        "name": "powerState",
                        "value": "ON",
                        "timeOfSample": "2017-02-03T16:20:50.52Z",
                        "uncertaintyInMilliseconds": 500
                    }
                ]
            },
            "event": {
                "header": {
                    "namespace": "Alexa",
                    "name": "Response",
                    "messageId": get_uuid(),
                    "correlationToken": request["directive"]["header"]["correlationToken"],
                    "payloadVersion": "3"
                },
                "endpoint":{
                    "endpointId":  request["directive"]["endpoint"]["endpointId"]
                },
                "payload": {}
            }           
        }
            
        return response              
            
    elif request_namespace == "Alexa.ChannelController":
        if request_name =="SkipChannels":
            request_data =  request["directive"]["payload"]["channelCount"]
            msg = "{" 
            msg += "\"AieraId\":\""
            msg +=endpoint_topic
            msg +="\","
            msg += "\"Data_Topics\":\""
            msg +=request_name
            msg +="\","
            msg += "\"RoomId\":\""
            msg +=aws_id
            #msg +=str(hex(uuid.getnode()))
            msg +="\"," 
            msg +="\"StatusId\":\""
            msg +=str(request_data)
            msg +="\"}"
            
        elif request_name == "ChangeChannel":
            request_data =  request["directive"]["payload"]["channel"]["number"]
            msg = "{" 
            msg += "\"AieraId\":\""
            msg +=endpoint_topic
            msg +="\","
            msg += "\"Data_Topics\":\""
            msg +=str(request_name)
            msg +="\","
            msg += "\"RoomId\":\""
            msg +=aws_id
            #msg +=str(hex(uuid.getnode()))
            msg +="\"," 
            msg +="\"StatusId\":\""
            msg +=request_data
            msg +="\"}"
                
        try:
            #mqttc.publish(pub_topic, msg, 1)
            mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
            #mqttc.publish(pub_topic, 1, msg)
        except:
            try:
                #mqttc.publish(pub_topic, msg, 1)
                mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                #mqttc.publish(pub_topic, 1, msg)
            except:
                print("DATA connection error")
        response={
            "context": {
                "properties": [
                    {
                        "namespace": "Alexa.ChannelController",
                        "name": "channel",
                        "value": {
                            "number": request_data,
                            "callSign": "callsign1",
                            "affiliateCallSign": "callsign2"
                        },
                        "timeOfSample": "2017-09-27T18:30:30.45Z",
                        "uncertaintyInMilliseconds": 200
                    },
                    {
                        "namespace": "Alexa.PowerController",
                        "name": "powerState",
                        "value": "ON",
                        "timeOfSample": "2017-02-03T16:20:50.52Z",
                        "uncertaintyInMilliseconds": 200
                    },
                    {
                        "namespace": "Alexa.EndpointHealth",
                        "name": "connectivity",
                        "value": {
                            "value": "OK"
                        },
                        "timeOfSample": "2017-09-27T18:30:30.45Z",
                        "uncertaintyInMilliseconds": 200
                    }
                ]
            },
            "event": {
                "header": {
                    "namespace": "Alexa",
                    "name": "Response",
                    "payloadVersion": "3",
                    "messageId": get_uuid(),
                    "correlationToken": request["directive"]["header"]["correlationToken"]
                },
                "endpoint": {
                    "scope": {
                        "type": "BearerToken",
                        "token": "access-token-from-Amazon"
                    },
                    "endpointId":  request["directive"]["endpoint"]["endpointId"]
                },
                "payload": {}
            }
        }
        return response            
            
    elif request_namespace == "Alexa.Authorization":
        if request_name == "AcceptGrant":
            response = {
                "event": {
                    "header": {
                        "namespace": "Alexa.Authorization",
                        "name": "AcceptGrant.Response",
                        "payloadVersion": "3",
                        "messageId": get_uuid()
                    },
                    "payload": {}
                }
            }
            return response
    
    elif request_namespace == "Alexa.ThermostatController":
        if request_name == "AdjustTargetTemperature":
            request_temperature = request["directive"]["payload"]["targetSetpointDelta"]["value"]
            #ac_remote.set_temperature(request_temperature)
            #request_data=request_data*20
            values = int(request_temperature)
            values2 = int(request_temperature)
            #values = str(request_data)
            msg = "{" 
            msg += "\"AieraId\":\""
            msg +=endpoint_topic
            msg +="\","
            msg += "\"Data_Topics\":\""
            msg +=request_name
            msg +="\","
            msg += "\"RoomId\":\""
            msg +=aws_id
            #msg +=str(hex(uuid.getnode()))
            msg +="\"," 
            msg +="\"StatusId\":\""
            msg +=str(values)
            msg +="\"}"
        elif request_name == "SetTargetTemperature":
            request_temperature = request["directive"]["payload"]["targetSetpoint"]["value"]
            #ac_remote.set_temperature(request_temperature)
            #request_data=request_data*20
            values = int(request_temperature+47)
            values2 = chr(values)
            #values = str(request_data)
            msg = "{" 
            msg += "\"AieraId\":\""
            msg +=endpoint_topic
            msg +="\","
            msg += "\"Data_Topics\":\""
            msg +=request_name
            msg +="\","
            msg += "\"RoomId\":\""
            msg +=aws_id
            #msg +=str(hex(uuid.getnode()))
            msg +="\"," 
            msg +="\"StatusId\":\""
            msg +=str(values2)
            msg +="\"}"        
        try:
            #mqttc.publish(pub_topic, msg, 1)
            mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
            #mqttc.publish(pub_topic, 1, msg)
        except:
            try:
                #mqttc.publish(pub_topic, msg, 1)
                mqtta.publish(topic='Aiera/Update', qos=1, payload=msg)
                #mqttc.publish(pub_topic, 1, msg)
            except:
                print("DATA connection error")     
        response = {
		    "context": {
			    "properties": [
					{
					"namespace": "Alexa.ThermostatController",
					"name": "targetSetpoint",
					"value": {
						"value": "AC",
						"scale": "FAHRENHEIT"
						},
					"timeOfSample": "2017-09-27T18:30:30.45Z",
					"uncertaintyInMilliseconds": 200
					},
					{
                    "namespace": "Alexa.TemperatureSensor",
                    "name": "temperature",
                    "value": {
                        "value": request_temperature,
                        "scale": "CELSIUS"
                        },
                    "timeOfSample": "2017-02-03T16:20:50.52Z",
                    "uncertaintyInMilliseconds": 1000
                    },
					{
						"namespace": "Alexa.ThermostatController",
						"name": "thermostatMode",
						"value": "AC",
						"timeOfSample": "2017-09-27T18:30:30.45Z",
						"uncertaintyInMilliseconds": 200
					},
					{
						"namespace": "Alexa.EndpointHealth",
						"name": "connectivity",
						"value": {
							"value": "OK"
						},
						"timeOfSample": "2017-09-27T18:30:30.45Z",
						"uncertaintyInMilliseconds": 200
					}
				]
			},
			"event": {
				"header": {
					"namespace": "Alexa",
					"name": "Response",
					"payloadVersion": "3",
					"messageId": get_uuid(),
					"correlationToken": request["directive"]["header"]["correlationToken"]
				},
				"endpoint": {
					"scope": {
						"type": "BearerToken",
						"token": "access-token-from-Amazon"
					},
				"endpointId":  request["directive"]["endpoint"]["endpointId"]
				},
				"payload": {}
			}
		}
        return response
        
    elif request_namespace == "Alexa":
        if request_name == "ReportState":
            response = {
                "context": {
                    "properties": [
                        {
                            "namespace": "Alexa.EndpointHealth",
                            "name": "connectivity",
                            "value": {
                                "value": "OK THEN"
                            },
                            "timeOfSample": get_utc_timestamp(),
                            "uncertaintyInMilliseconds": 200
                        },
                        {
                            "name": "powerState",
                            "namespace": "Alexa.PowerController",
                            "value":"Value",
                            "timeOfSample": get_utc_timestamp(),
                            "uncertaintyInMilliseconds": 200
                        },
						{
							"namespace": "Alexa.RangeController",
							"instance": "Fan.Speed",
							"name": "rangeValue",
							"value": 4,
							"timeOfSample": "2017-02-03T16:20:50.52Z",
							"uncertaintyInMilliseconds": 200
                        },
                        {
                            "namespace": "Alexa.PowerLevelController",
                            "name": "powerLevel",
                            "value": 42,
                            "timeOfSample": "2017-09-27T18:30:30.45Z",
                            "uncertaintyInMilliseconds": 200
                        },
                        {
                            "namespace": "Alexa.ChannelController",
                            "name": "channel",
                            "value": {
                                "number": "1234",
                                "callSign": "callsign1",
                                "affiliateCallSign": "callsign2"
                            },
                            "timeOfSample": "2017-09-27T18:30:30.45Z",
                            "uncertaintyInMilliseconds": 200
                        },
                        {
                            "name": "thermostatMode",
                            "namespace": "Alexa.ThermostatController",
                            "value": "AUTO",
                            "timeOfSample": "2017-09-27T18:30:30.45Z",
                            "uncertaintyInMilliseconds": 200
                        },
                        {
                            "name": "temperature",
                            "namespace": "Alexa.TemperatureSensor",
                            "value": {
                                "scale": "FAHRENHEIT",
                                "value": 22
                            },
                            "timeOfSample": "2017-09-27T18:30:30.45Z",
                            "uncertaintyInMilliseconds": 200
                        },
                        {
                            "namespace": "Alexa.Speaker",
                            "name": "volume",
                            "value": 50,
                            "timeOfSample": "2017-02-03T16:20:50.52Z",
                            "uncertaintyInMilliseconds":200
                        },
                        {
                            "namespace": "Alexa.Speaker",
                            "name": "muted",
                            "value": False,
                            "timeOfSample": "2017-02-03T16:20:50.52Z",
                            "uncertaintyInMilliseconds": 200
                        }
                    ]
                },
                "event": {
                    "header": {
                        "namespace": "Alexa",
                        "name": "StateReport",
                        "payloadVersion": "3",
                        "messageId": get_uuid(),
                        "correlationToken": request["directive"]["header"]["correlationToken"]
                    },
                    "endpoint": {
                        "scope": {
                            "type": "BearerToken",
                            "token": "access-token-from-Amazon"
                        },
                        "endpointId": request["directive"]["endpoint"]["endpointId"]
                    },
                    "payload": {}
                }
            }
            return response
    # other handlers omitted in this example

# v3 utility functions
def get_endpoint_from_v2_appliance(appliance):
    endpoint = {
        "endpointId": appliance["applianceId"],
        "manufacturerName": appliance["manufacturerName"],
        "friendlyName": appliance["friendlyName"],
        "displayCategories": [],
        "cookie": appliance["additionalApplianceDetails"],
        "capabilities": []
    }
    endpoint["displayCategories"] = get_display_categories_from_v2_appliance(appliance)
    endpoint["capabilities"] = get_capabilities_from_v2_appliance(appliance)
    return endpoint

def get_directive_version(request):
    try:
        return request["directive"]["header"]["payloadVersion"]
    except:
        try:
            return request["header"]["payloadVersion"]
        except:
            return "-1"

def get_endpoint_by_endpoint_id(endpoint_id):
    appliance = get_appliance_by_appliance_id(endpoint_id)
    if appliance:
        return get_endpoint_from_v2_appliance(appliance)
    return None

def get_display_categories_from_v2_appliance(appliance):
    model_name = appliance["modelName"]
    if model_name == "Smart Switch": displayCategories = ["SWITCH"]
    elif model_name == "Smart Light": displayCategories = ["LIGHT"]
    elif model_name == "Smart TV": displayCategories = ["TV"]
    elif model_name == "Smart Fan": displayCategories = ["FAN"]
    elif model_name == "Smart White Light": displayCategories = ["LIGHT"]
    elif model_name == "Smart Thermostat": displayCategories = ["THERMOSTAT"]
    elif model_name == "Smart Speaker": displayCategories = ["TV"]
    elif model_name == "Smart Scene": displayCategories = ["SCENE_TRIGGER"]
    elif model_name == "Smart Activity": displayCategories = ["ACTIVITY_TRIGGER"]
    else: displayCategories = ["OTHER"]
    return displayCategories
    
def get_capabilities_from_v2_appliance(appliance):
    model_name = appliance["modelName"]
    if model_name == 'Smart Switch':
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerState" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]
    elif model_name == "Smart Light":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerState" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]
    elif model_name == "Smart TV":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerState" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.ChannelController",
                "version": "3",
                "properties": {
                    "supported": [
                        {"name": "channel"  }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]
    elif model_name == "Smart Fan":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerLevelController",
                "instance": "Fan.Speed",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerLevel" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
			{
                "type": "AlexaInterface",
                "interface": "Alexa.PercentageController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "percentage" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerState" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]
    elif model_name == "Smart White Light":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerState" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.ColorTemperatureController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "colorTemperatureInKelvin" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.BrightnessController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "brightness" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerLevelController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerLevel" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PercentageController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "percentage" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]
    elif model_name == "Smart Thermostat":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.ThermostatController",
                "instance": "AC.powerState",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "targetSetpoint" },
                        { "name": "thermostatMode" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                },
                "configuration": {
                    "supportedModes": [ "HEAT", "COOL" ],
                    "supportsScheduling": False
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerState" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.TemperatureSensor",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "temperature" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]

    elif model_name == "Smart Thermostat Dual":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.ThermostatController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "upperSetpoint" },
                        { "name": "lowerSetpoint" },
                        { "name": "thermostatMode" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
                "type": "AlexaInterface",
                "interface": "Alexa.TemperatureSensor",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "temperature" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]
    elif model_name == "Smart Speaker":
        capabilities = [

            {
                "type": "AlexaInterface",
                "interface": "Alexa.ChannelController",
                "version": "3",
                "properties": {
                    "supported": [
                        {"name": "channel"  }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            },
            {
              "type": "AlexaInterface",
              "interface": "Alexa.Speaker",
              "version": "3",
              "properties": {
                "supported": [
                  {
                    "name": "volume"
                  },
                  {
                    "name": "muted"
                  }
                ],
                "retrievable": True,
                "proactivelyReported": True
              }
            }
            
        ]  
    elif model_name == "Smart Lock":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.LockController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "lockState" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]
    elif model_name == "Smart Scene":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.SceneController",
                "version": "3",
                "supportsDeactivation": False,
                "proactivelyReported": True
            }
        ]
    elif model_name == "Smart Activity":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.SceneController",
                "version": "3",
                "supportsDeactivation": True,
                "proactivelyReported": True
            }
        ]
    elif model_name == "Smart Camera":
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.CameraStreamController",
                "version": "3",
                "cameraStreamConfigurations" : [ {
                    "protocols": ["RTSP"],
                    "resolutions": [{"width":1280, "height":720}],
                    "authorizationTypes": ["NONE"],
                    "videoCodecs": ["H264"],
                    "audioCodecs": ["AAC"]
                } ]
            }
        ]
    else:
        # in this example, just return simple on/off capability
        capabilities = [
            {
                "type": "AlexaInterface",
                "interface": "Alexa.PowerController",
                "version": "3",
                "properties": {
                    "supported": [
                        { "name": "powerState" }
                    ],
                    "proactivelyReported": True,
                    "retrievable": True
                }
            }
        ]

    # additional capabilities that are required for each endpoint
    endpoint_health_capability = {
        "type": "AlexaInterface",
        "interface": "Alexa.EndpointHealth",
        "version": "3",
        "properties": {
            "supported":[
                { "name":"connectivity" }
            ],
            "proactivelyReported": True,
            "retrievable": True
        }
    }
    alexa_interface_capability = {
        "type": "AlexaInterface",
        "interface": "Alexa",
        "version": "3"
    }
    capabilities.append(endpoint_health_capability)
    capabilities.append(alexa_interface_capability)
    return capabilities