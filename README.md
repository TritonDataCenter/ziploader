# Using ziploader to view Triton traces

## Warnings/Notes

 * This tool is still very experimental and output is overly obscure and
   verbose. Eventually this will be cleaned up.

 * Only restify spans are fully supported for now. Other spans should show up
   but may have weird behaviors.

 * This tool is part of the work on [RFD 35](https://github.com/joyent/rfd/tree/master/rfd/0035)

## Installing (run from the Triton GZ)

For now ziploader is built as a tarball. You can install the latest version using:

```
(rm -rf /opt/custom/ziploader \
    && mkdir /opt/custom/ziploader \
    && cd /opt/custom/ziploader \
    && updates-imgadm get-file -C experimental -o /tmp/ziploader.$$.tgz \
        $(updates-imgadm list --latest -C experimental -H -o uuid name=ziploader) \
    && tar -zxvf /tmp/ziploader.$$.tgz \
    && rm /tmp/ziploader.$$.tgz)
```

which will wipe out your existing /opt/custom/ziploader and load the latest version.

## Create a Zipkin instance (run on your computer)

NOTE: this needs to be accessible from the GZ of the host you're running this
tool on, but it should also probably not be open to the Internet since there's
no encryption or authentication.

```
# docker run --name zippy -d -p 9411:9411 openzipkin/zipkin
18ce72a6b7264d288a373de589dcb64d013ff4fe214c42d4a93cd3195ecc11bd
```

## Find the IP of the Zipkin instance (run on your computer)

```
# docker inspect --format='{{.NetworkSettings.IPAddress}}' zippy
172.26.6.139
```

## Start the ziploader, pointing at this zipkin instance (run from the Triton GZ)

```
# /opt/custom/ziploader/ziploader.js -H 172.26.6.139
```

Command-click (assuming iTerm) on the links as they pop up in the console to
view the traces.

